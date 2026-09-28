-- ─────────────────────────────────────────────────────────────────────────
-- Repairing what the broken Zoho pull left behind, as far as local data can
--
-- The pull from Zoho Projects had been returning 403 on every project since
-- 2026-09-07, and even before that it never wrote an owner or a completion
-- date onto a task it imported. The Accountability Dashboard counts a
-- person's work strictly through task_people (accountability_weeks joins
-- role = 'assignee') and counts finished work strictly by the DATE in
-- completed_at, so 2804 of 2810 imported tasks were invisible to it and 1489
-- finished ones scored nothing. That is "for Gustavo I can only see one task,
-- and Traction is done but the dashboard says it isn't".
--
-- The code fix is in zoho-projects-poll and zoho-projects. This migration
-- repairs what is already sitting in this database, and makes the three
-- database-side changes that fix needs to work.
--
-- WHAT IT REPAIRS
--   1. The one HTML-escaped tasklist name ("Gustavo ( Finance Controller
--      &amp; Bookkeeper)"). Cosmetic, and it is the row he is looking at.
--   2. Assignees on the Accountabilities project ONLY, read off the Zoho
--      tasklist the task already sits in, because that project files its
--      lists by person. 18 rows: 22 tasks sit in a person's list with nobody
--      on them, and 4 of those are Luciana's, who has no profiles row.
--
-- WHAT IT CHANGES FOR THE REPAIRED CODE (sections 3 to 5 at the bottom)
--   3. A third value on zoho_sync_conflicts.resolution, for an overwrite the
--      pull cannot justify.
--   4. Somewhere durable for a poll run to leave its summary.
--   5. A read timeout on the pg_cron job that calls the poll.
--
-- WHAT IT DELIBERATELY LEAVES ALONE, and why
--   - completed_at on the 1489 finished tasks that have none. There is no
--     honest local source. For most of them created_at = updated_at = the
--     2026-09-07 import, which is the day TMG heard about the task, not the
--     day the work was done. Dating them from that would credit month-old
--     work to the wrong week and quietly corrupt the scorecard, which is
--     worse than leaving it blank. Zoho's completion time is the only real
--     answer and it arrives on the first successful poll.
--   - zoho_last_modified_time on all 2810 rows. No local source by
--     definition. The repaired detector treats a null as "changed", so the
--     next poll fills it in once and then settles.
--   - Assignees on the ~2782 CTC-file tasks. Their tasklists are named after
--     deal phases ("Pre-List", "Clear to Close", "Marketing Maintenance"),
--     not people, so name matching there would invent owners rather than
--     recover them. Only Zoho's own owner field can answer, on the next poll.
--   - Luciana's 4 Accountabilities tasks. She holds a Zoho tasklist and has
--     no profiles row at all, so there is nobody here to point them at. They
--     stay unassigned until she has an account.
--   - due_at on the 1402 Zoho dates that are stored a day early. They sit at
--     midnight UTC, which reads as the day BEFORE through America/Chicago,
--     which is the zone the app and accountability_weeks both read due_at
--     through. The code fix stores midnight Chicago instead, and no statement
--     is needed here because the first catch-up run rewrites every one of
--     them: all 2810 imported rows still have a null zoho_last_modified_time,
--     which makes each one read as CHANGED and each project read in FULL, and
--     one run covers 60 pages of 200 tasks against 2810 rows. Checked against
--     live data that the rewrite writes no "Due date moved" line on any of the
--     1408 dated rows: shortDate reads the old midnight-UTC spelling in UTC
--     and the corrected one in Chicago, and gets the same day out of both.
--
-- Safe to run twice: every statement is a no-op the second time.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Un-escape tasklist names. They arrive from Zoho HTML-escaped and get
-- stored raw, so an ampersand or an apostrophe in a list name renders wrong
-- wherever the name is shown. Ampersand is undone LAST, otherwise "&amp;lt;"
-- would decode two steps in one pass. Idempotent because a decoded string has
-- no entities left to decode.
--
-- The pull now decodes on the way in (decodeEntities, in both sync functions),
-- so nothing re-escapes this row five minutes later. This statement stays
-- anyway, because the poll is the thing that has been answering 403 since
-- 2026-09-07: a repair that only lands once the broken job starts working
-- again is not a repair. This makes the name right the moment the migration
-- runs, and the code keeps it right from the first successful poll onward.
-- Only the tasklist name needs this. Task titles are not escaped by Zoho (275
-- hold a bare "&" and none holds an entity) and descriptions must never be
-- touched, because Zoho sends them as whole HTML documents where "&amp;" is
-- correct markup.
update public.tasks
   set zoho_tasklist_name = replace(replace(replace(replace(replace(
         zoho_tasklist_name,
         '&lt;', '<'), '&gt;', '>'), '&quot;', '"'), '&#39;', ''''), '&amp;', '&')
 where zoho_tasklist_name is not null
   and zoho_tasklist_name ~ '&(amp|lt|gt|quot|#39);';

-- 2. Assignees for the Accountabilities project, from the tasklist the task
-- is already filed in.
--
-- Scoped to that ONE project by its Zoho id rather than by name, matching
-- 20260924120000, so a rename in the app cannot point this somewhere else.
-- The scoping is the whole safety of this statement: Accountabilities is the
-- only project whose Zoho tasklists are named after people.
--
-- Matching is the same leading-word rule the sync code and tasks.jsx both
-- use, and for the same reason: these names are freehand ("Alexa (TC)",
-- "Symon (O.M.)", "Luciana (E.A. to Tarek)") and only the first word names
-- anybody. Matching the whole string would file Luciana's work under Tarek.
-- Three letters is the floor because two would match half the team, and
-- either side may be the short form of the other ("Alexa" / "Alexandra").
with candidate as (
  select t.id as task_id,
         t.created_at,
         split_part(
           trim(regexp_replace(lower(t.zoho_tasklist_name), '[^a-z]+', ' ', 'g')),
           ' ', 1) as lead_word
    from public.tasks t
    join public.projects p on p.id = t.project_id
   where p.zoho_project_id = '2435905000000202003'
     and t.zoho_tasklist_name is not null
     -- Only tasks nobody has claimed. A task that already has an assignee has
     -- been answered by a person or by Zoho, and this rule does not get to
     -- add a second name on top of it.
     and not exists (
       select 1 from public.task_people tp
        where tp.task_id = t.id and tp.role = 'assignee')
),
matched as (
  select c.task_id,
         c.created_at,
         -- Exactly one profile, or none. An ambiguous name is left for the
         -- poll to answer from Zoho's own owner field: filing one person's
         -- work under another is worse than leaving it unfiled.
         (select (array_agg(pr.id))[1]
            from public.profiles pr
           where (pr.status is null or pr.status = 'active')
             and length(c.lead_word) >= 3
             and length(lower(coalesce(pr.first_name, ''))) >= 3
             and (lower(pr.first_name) like c.lead_word || '%'
               or c.lead_word like lower(pr.first_name) || '%')
          having count(*) = 1) as user_id
    from candidate c
)
insert into public.task_people (task_id, user_id, role, assigned_at)
select m.task_id, m.user_id, 'assignee',
       -- Dated from the task, not from now(). accountability_weeks buckets
       -- its "assigned" column by assigned_at, so stamping today would drop a
       -- month of history into this week and make the dashboard wrong in a
       -- new way. Same convention as 20260910120000_accountability_weeks.
       m.created_at
  from matched m
 where m.user_id is not null
    on conflict (task_id, user_id, role) do nothing;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. A name for the overwrite nobody could see
--
-- The pull takes Zoho's values whenever it cannot prove TMG's are newer, and
-- it cannot prove it whenever Zoho sends no modified time or TMG has never
-- held one. Zoho winning there is the rule and is not changing. What was
-- wrong is that those overwrites were the only ones that logged nothing at
-- all: a title typed in the app at 9:00 and replaced by the 9:05 poll left no
-- conflict row and no line on the task, so the person who lost the edit could
-- not tell it from their own mistake.
--
-- 'zoho_won' would be a lie about what happened, because nothing here won on
-- the merits. The third value says so in the row itself, so these are
-- countable separately from the conflicts that were genuinely decided.
alter table public.zoho_sync_conflicts
  drop constraint if exists zoho_sync_conflicts_resolution_check;
alter table public.zoho_sync_conflicts
  add constraint zoho_sync_conflicts_resolution_check
  check (resolution in ('tmg_won', 'zoho_won', 'zoho_won_unverified'));

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Somewhere the poll's own answer survives the run
--
-- pg_net keeps the HTTP response for six hours, and only for a call that did
-- not time out. 34 of the 138 responses it has stored timed out already, on
-- the trivial workload of a 403 per project, so the run's own summary was the
-- one thing about this job nobody could read afterwards. The catch-up run
-- walks 2810 tasks and would have timed out every time.
--
-- One row, overwritten every tick, on the single-row connection table this
-- job already updates for its token and user cache:
--   select last_poll_at, jsonb_pretty(last_poll_summary)
--     from public.zoho_projects_connection;
-- The table has RLS on and no policies, so this stays service-role only,
-- exactly like the token beside it.
alter table public.zoho_projects_connection
  add column if not exists last_poll_at      timestamptz,
  add column if not exists last_poll_summary jsonb;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. The cron job has to wait longer than five seconds
--
-- cron.job 2 calls net.http_post with no timeout_milliseconds, so pg_net
-- gives up at its 5 second default and records a timeout instead of the
-- response. The run itself is unharmed (each task UPDATE has already
-- committed, the project stamp is simply skipped and the next tick resumes),
-- so this is observability, not correctness. 120 seconds matches the
-- google-tasks-sync job, which had the same problem for the same reason.
--
-- The sibling cron migrations (20260826150000, 20260910110000) only DOCUMENT
-- their jobs, because provisioning them means creating a vault secret and the
-- raw value must never land in git. This one is different and is safe to run:
-- it changes a timeout on a job that already exists, and the body below reads
-- the secret out of the vault at run time exactly as the live job does, so no
-- secret passes through this file. Guarded, so an environment without pg_cron
-- or without the job simply skips it.
do $poll_timeout$
begin
  if to_regclass('cron.job') is null
     or not exists (select 1 from cron.job where jobname = 'zoho-projects-poll') then
    raise notice 'no zoho-projects-poll cron job here, leaving the timeout alone';
    return;
  end if;
  perform cron.schedule('zoho-projects-poll', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/zoho-projects-poll',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'zoho_poll_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $job$);
end
$poll_timeout$;
