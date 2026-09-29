-- Task statuses now match Zoho Projects' eight: todo, in_progress, submitted,
-- revision, stuck, on_hold, done ("Completed") and cancelled.
--
-- Symon, 2026-09-29: "Sync the status from Zoho across the app". Until now the
-- app knew four, and every Zoho status it did not recognise arrived as To Do,
-- so 460 tasks cancelled in Zoho sat in the app as open and overdue work.
--
-- Two of the eight are CLOSED: done and cancelled. The counting functions below
-- used "status <> 'done'" to mean "still open", which counts a cancelled task
-- as open and overdue forever. Same signatures, so both are replaced in place
-- and nothing that calls them changes.

-- Per-project counts for the CTC Files / Projects list (see 20260909120000).
--   total    the tasks that are real work: cancelled ones are left out, so a
--            file whose plan dropped ten steps does not read as 10 short
--   done     Completed
--   stuck    Stuck (still the only status that flags a file as blocked)
--   overdue  open in any of the six open ways and past due
create or replace function public.project_task_stats()
returns table (
  project_id  uuid,
  total       integer,
  done        integer,
  stuck       integer,
  overdue     integer,
  any_dates   boolean
)
language sql
stable
security invoker          -- runs as the caller, so RLS on tasks still applies
set search_path = public
as $$
  select
    t.project_id,
    count(*) filter (where t.status <> 'cancelled')::int,
    count(*) filter (where t.status = 'done')::int,
    count(*) filter (where t.status = 'stuck')::int,
    count(*) filter (where t.status not in ('done', 'cancelled') and t.due_at is not null and t.due_at < now())::int,
    coalesce(bool_or(t.due_at is not null) filter (where t.status <> 'cancelled'), false)
  from public.tasks t
  where t.project_id is not null
  group by t.project_id
$$;

-- Weekly accountability tally (see 20260910120000 for what each number means).
--   completed   now also requires the task to BE completed. It used to count
--               any completed_at in the week, and a cancelled task carrying a
--               completion date from Zoho would have scored as finished work.
--               On 2026-09-29 no task holds a completed_at without being done,
--               so no past week's number moves.
--   still_open  and overdue leave cancelled tasks out, like done ones.
--   assigned    unchanged: a task that was later cancelled was still assigned.
create or replace function public.accountability_weeks(week_count int default 6)
returns table (
  user_id    uuid,
  week_start date,
  assigned   int,
  completed  int,
  still_open int,
  overdue    int
)
language sql
stable
security invoker
set search_path = public
as $$
  with weeks as (
    -- date_trunc('week', ...) is ISO, so it already lands on Monday. Chicago
    -- local, not UTC: a task completed at 7pm Sunday in Texas belongs to that
    -- week, not the next one.
    select (date_trunc('week', (now() at time zone 'America/Chicago'))::date - (n * 7)) as week_start
      from generate_series(0, greatest(coalesce(week_count, 6), 1) - 1) as n
  ),
  mine as (
    select tp.user_id,
           t.status,
           (t.due_at       at time zone 'America/Chicago')::date as due_d,
           (t.completed_at at time zone 'America/Chicago')::date as done_d,
           (coalesce(tp.assigned_at, t.created_at) at time zone 'America/Chicago')::date as assigned_d
      from public.task_people tp
      join public.tasks t on t.id = tp.task_id
     where tp.role = 'assignee'
  ),
  today as (select (now() at time zone 'America/Chicago')::date as d)
  select m.user_id,
         w.week_start,
         count(*) filter (
           where m.assigned_d >= w.week_start and m.assigned_d < w.week_start + 7)::int,
         count(*) filter (
           where m.status = 'done'
             and m.done_d     >= w.week_start and m.done_d     < w.week_start + 7)::int,
         count(*) filter (
           where m.status not in ('done', 'cancelled')
             and m.assigned_d >= w.week_start and m.assigned_d < w.week_start + 7)::int,
         count(*) filter (
           where m.status not in ('done', 'cancelled')
             and m.assigned_d >= w.week_start and m.assigned_d < w.week_start + 7
             and m.due_d is not null and m.due_d < (select d from today))::int
    from weeks w
    cross join mine m
   group by m.user_id, w.week_start;
$$;

comment on column public.tasks.status is
  'Matches Zoho Projects: todo, in_progress, submitted, revision, stuck, on_hold, done (Completed), cancelled. done and cancelled are closed.';

grant execute on function public.project_task_stats() to authenticated;
grant execute on function public.accountability_weeks(int) to authenticated;
