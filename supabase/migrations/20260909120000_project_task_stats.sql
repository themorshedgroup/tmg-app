-- Per-project task counts, so the CTC Files / Projects / Rocks LIST doesn't
-- have to load task rows at all.
--
-- Symon, 2026-09-09: "Agents will show all CTC files. And whatever is the CTC
-- file that they open, that's what gets loaded." The list previously loaded
-- every task in the database (2,880 rows) purely to render per-file counts and
-- an attention flag. This returns one row per project instead; the tasks
-- themselves load when a file is opened.
--
-- Milestones are still fetched as rows by the client — the list draws the
-- milestone chain and next-milestone date from them, and there are only a
-- handful per file.
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
    count(*)::int,
    count(*) filter (where t.status = 'done')::int,
    count(*) filter (where t.status = 'stuck')::int,
    count(*) filter (where t.status <> 'done' and t.due_at is not null and t.due_at < now())::int,
    bool_or(t.due_at is not null)
  from public.tasks t
  where t.project_id is not null
  group by t.project_id
$$;

grant execute on function public.project_task_stats() to authenticated;
