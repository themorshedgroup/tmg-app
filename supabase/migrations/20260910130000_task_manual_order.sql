-- ─────────────────────────────────────────────────────────────────────────
-- Shared manual ordering for tasks and for the Zoho tasklist headers.
--
-- Two rank columns, not one. A CTC file's list and My Tasks are different
-- sequences over overlapping sets: My Tasks shows a few dozen rows drawn from
-- many different files, so writing THAT order into the file-scoped column
-- would silently reorder files nobody opened. list_rank is the file's order,
-- shared with everyone who opens the file; my_rank is the My Tasks spine.
--
-- Fractional (gap) ranks with a step of 1024: a normal drop writes ONE row, so
-- two people dragging different tasks commute and both moves survive.
-- Renumbering every row on every drop is what makes a stale client silently
-- revert someone else's move.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.tasks
  add column if not exists list_rank double precision,
  add column if not exists my_rank   double precision;

create index if not exists tasks_project_list_rank_idx on public.tasks (project_id, list_rank);
create index if not exists tasks_my_rank_idx           on public.tasks (my_rank);

-- zoho_tasklist_id / zoho_tasklist_name are denormalised columns on `tasks` —
-- there is no tasklist row to hang a rank on, so it gets its own small table.
-- One row per header rather than an array on projects: an array write is
-- last-writer-wins between two people, per-row writes commute.
create table if not exists public.project_tasklist_order (
  project_id   uuid not null references public.projects(id) on delete cascade,
  tasklist_key text not null,          -- zoho_tasklist_id, else 'name:'||zoho_tasklist_name
  rank         double precision not null,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  primary key (project_id, tasklist_key)
);
create index if not exists ptlo_project_idx on public.project_tasklist_order (project_id);

alter table public.project_tasklist_order enable row level security;
-- Mirrors the existing policy on tasks/task_people: any signed-in TMG account
-- reads and writes. That permissiveness IS the "everyone sees the same order"
-- requirement.
drop policy if exists ptlo_rw on public.project_tasklist_order;
create policy ptlo_rw on public.project_tasklist_order
  for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
grant select, insert, update, delete on public.project_tasklist_order to authenticated;

-- ── Backfill ────────────────────────────────────────────────────────────
-- list_rank reproduces exactly what a file shows today: tasklist groups in
-- earliest-created order, then created_at inside each group. Nothing visibly
-- moves on deploy day — the file just stops reshuffling itself between loads.
with g as (
  select project_id,
         coalesce(zoho_tasklist_name, '~~other') as gname,
         min(created_at)                         as g_first
    from public.tasks
   where project_id is not null
   group by 1, 2
), ranked as (
  select t.id,
         row_number() over (
           partition by t.project_id
           order by g.g_first nulls last, g.gname, t.created_at nulls last, t.id
         ) * 1024.0 as r
    from public.tasks t
    join g on g.project_id = t.project_id
          and g.gname      = coalesce(t.zoho_tasklist_name, '~~other')
   where t.project_id is not null
)
update public.tasks t set list_rank = ranked.r
  from ranked where t.id = ranked.id and t.list_rank is null;

-- my_rank reproduces today's My Tasks order: newest first. New tasks keep
-- landing at the top.
with r as (
  select id, row_number() over (order by created_at desc nulls last, id) * 1024.0 as rk
    from public.tasks
)
update public.tasks t set my_rank = r.rk
  from r where t.id = r.id and t.my_rank is null;

-- project_tasklist_order is deliberately NOT back-filled. Empty means "fall
-- back to earliest-created", i.e. today's behaviour exactly; a file's header
-- order only becomes stored the first time someone drags one.

-- ── A rank for every future insert ──────────────────────────────────────
-- Covers all four inserters with no client code and no edge-function redeploy:
-- TaskDB.create, zoho-projects-poll (every 5 min), zoho-projects "Sync now",
-- and google-tasks-sync. security definer so the poller's service-role insert
-- and a user's insert compute the same thing.
create or replace function public.tasks_default_rank() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.list_rank is null and new.project_id is not null then
    select coalesce(max(list_rank), 0) + 1024 into new.list_rank
      from public.tasks where project_id = new.project_id;
  end if;
  if new.my_rank is null then
    select coalesce(min(my_rank), 0) - 1024 into new.my_rank from public.tasks;
  end if;
  return new;
end $$;

drop trigger if exists tasks_default_rank on public.tasks;
create trigger tasks_default_rank before insert on public.tasks
  for each row execute function public.tasks_default_rank();

-- ── The rare many-row write ─────────────────────────────────────────────
-- Only fires when a gap between two neighbours collapses below 1e-6, which
-- takes ~52 consecutive drops into the same slot. Shaped like
-- project_task_stats(): security invoker, so the existing RLS still governs,
-- and updated_at is never touched.
create or replace function public.reorder_tasks(p_col text, p_rows jsonb)
returns void language plpgsql volatile security invoker set search_path = public as $$
begin
  if p_col not in ('list_rank', 'my_rank') then
    raise exception 'reorder_tasks: bad column %', p_col;
  end if;
  if p_col = 'list_rank' then
    update public.tasks t set list_rank = x.rank
      from jsonb_to_recordset(p_rows) as x(id uuid, rank double precision)
     where t.id = x.id;
  else
    update public.tasks t set my_rank = x.rank
      from jsonb_to_recordset(p_rows) as x(id uuid, rank double precision)
     where t.id = x.id;
  end if;
end $$;
grant execute on function public.reorder_tasks(text, jsonb) to authenticated;

-- ── Realtime, so a teammate's drag lands on your screen ─────────────────
-- The client subscribes only to the one project it has open.
do $$
begin
  if not exists (select 1 from pg_publication_rel r
                   join pg_publication p on p.oid = r.prpubid
                   join pg_class c on c.oid = r.prrelid
                  where p.pubname = 'supabase_realtime' and c.relname = 'tasks') then
    alter publication supabase_realtime add table public.tasks;
  end if;
  if not exists (select 1 from pg_publication_rel r
                   join pg_publication p on p.oid = r.prpubid
                   join pg_class c on c.oid = r.prrelid
                  where p.pubname = 'supabase_realtime' and c.relname = 'project_tasklist_order') then
    alter publication supabase_realtime add table public.project_tasklist_order;
  end if;
end $$;
