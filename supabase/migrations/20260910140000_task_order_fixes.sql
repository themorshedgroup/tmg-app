-- ─────────────────────────────────────────────────────────────────────────
-- Two corrections to 20260910130000_task_manual_order.sql, both found by an
-- adversarial review of the drag feature before it shipped.
--
-- 1. tasks.my_rank is ONE column, but My Tasks is a different list for every
--    person. A task you delegated shows up in your list AND in theirs (the
--    query is "assignee or decision_maker"), so one person dragging it wrote
--    a new position into everybody else's list. Personal order moves into a
--    per-user table; tasks.my_rank stays as the shared starting position, so
--    a task nobody has dragged still lands where it always did — at the top.
--
-- 2. list_rank was filled on INSERT only. A task created with no file and
--    filed later kept a null rank forever, sorted to the bottom, and then
--    poisoned the midpoint arithmetic for any row dropped next to it.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Personal order ───────────────────────────────────────────────────
create table if not exists public.task_user_order (
  user_id    uuid not null,
  task_id    uuid not null references public.tasks(id) on delete cascade,
  rank       double precision not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
create index if not exists tuo_user_idx on public.task_user_order (user_id);

alter table public.task_user_order enable row level security;
-- Own rows only. Unlike project_tasklist_order (deliberately shared, because a
-- file's order is meant to be everyone's), this table is the opposite: it
-- exists precisely so one person's order is invisible to everyone else.
drop policy if exists tuo_own on public.task_user_order;
create policy tuo_own on public.task_user_order
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on public.task_user_order to authenticated;

-- No backfill on purpose. An absent row means "use tasks.my_rank", which is
-- exactly today's order — so nothing moves on deploy day, and a person's rows
-- only start existing the first time they drag something.

-- ── 2. A rank when a task is filed after the fact ───────────────────────
create or replace function public.tasks_rank_on_file() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  select coalesce(max(list_rank), 0) + 1024 into new.list_rank
    from public.tasks where project_id = new.project_id;
  return new;
end $$;

drop trigger if exists tasks_rank_on_file on public.tasks;
create trigger tasks_rank_on_file before update on public.tasks
  for each row when (new.project_id is not null and new.list_rank is null)
  execute function public.tasks_rank_on_file();

-- Catch anything already in that state.
with r as (
  select id, project_id,
         row_number() over (partition by project_id order by created_at nulls last, id) as n
    from public.tasks
   where project_id is not null and list_rank is null
), m as (
  select project_id, coalesce(max(list_rank), 0) as top
    from public.tasks where project_id is not null group by 1
)
update public.tasks t set list_rank = m.top + r.n * 1024.0
  from r join m on m.project_id = r.project_id
 where t.id = r.id;
