-- ─────────────────────────────────────────────────────────────────────────
-- Weekly accountability tally.
--
-- TMG weeks start on Monday (e.g. Sep 7–13). Two dates decide where a task
-- lands: when it was ASSIGNED to a person, and when it was COMPLETED. The
-- completion date is what credits the work to a week — that is the number the
-- scorecard reads.
--
-- task_people had no date of its own, so "assigned" could only ever mean "the
-- task was created". assigned_at fixes that: it is stamped when a person is
-- put on a task, and back-filled from the task's own created_at for the rows
-- that already existed.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.task_people
  add column if not exists assigned_at timestamptz not null default now();

-- Existing rows all defaulted to "now" when the column landed, which would
-- pile every historical task into this week. The task's own creation date is
-- the honest estimate for when somebody was put on it.
update public.task_people tp
   set assigned_at = t.created_at
  from public.tasks t
 where t.id = tp.task_id
   and t.created_at is not null
   and tp.assigned_at > t.created_at + interval '1 minute';

create index if not exists task_people_assigned_at_idx on public.task_people (assigned_at);

-- Per person, per week. security invoker on purpose: tasks and task_people
-- are already readable by any signed-in TMG account, so this adds no reach —
-- it just does the counting in one round trip instead of pulling 2,900 rows
-- into the browser.
--
-- The four numbers, and what each one honestly means:
--   assigned    put on this person during that week
--   completed   finished during that week, whenever it was assigned — this is
--               the one that counts toward the scorecard
--   still_open  assigned that week and STILL not done, as of right now
--   overdue     still_open and its due date has already passed
-- still_open and overdue are "as of today" by nature; the app has no history
-- of what a task's status was on a past Friday, and inventing one would be
-- worse than saying so.
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
           where m.done_d     >= w.week_start and m.done_d     < w.week_start + 7)::int,
         count(*) filter (
           where m.status <> 'done'
             and m.assigned_d >= w.week_start and m.assigned_d < w.week_start + 7)::int,
         count(*) filter (
           where m.status <> 'done'
             and m.assigned_d >= w.week_start and m.assigned_d < w.week_start + 7
             and m.due_d is not null and m.due_d < (select d from today))::int
    from weeks w
    cross join mine m
   group by m.user_id, w.week_start;
$$;

grant execute on function public.accountability_weeks(int) to authenticated;
