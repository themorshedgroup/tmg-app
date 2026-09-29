-- Google Tasks switch, per project and per task.
--
-- google-tasks-sync copies every task assigned to someone into that person's
-- Google Tasks. Once the Zoho pull started filling in owners (20260924140000),
-- a Transaction Coordinator became the assignee of nearly every checklist item
-- on every CTC file, and the sync started filling her phone with all of them.
--
-- The rule the sync now follows, first match wins:
--   1. tasks.google_tasks_sync     true = always send, false = never send
--   2. projects.google_tasks_sync  same, for every task in the project
--   3. neither set (null)          send, EXCEPT a CTC file's tasks to anyone
--                                  whose profiles.access includes 'tc'
--
-- Null is the default on both, so adding these changes nothing by itself;
-- the TC exclusion lives in the function. When a task stops qualifying, the
-- sync deletes the copy it made in that person's Google Tasks. Tasks that
-- came IN from a meeting agenda are never deleted: those are the Doc's own.
--
-- Plain columns on tables that already carry their grants, so no new grants.

alter table public.projects add column if not exists google_tasks_sync boolean;
alter table public.tasks    add column if not exists google_tasks_sync boolean;

comment on column public.projects.google_tasks_sync is
  'Google Tasks for every task in this project: true = always send, false = never send, null = automatic (all assignees except Transaction Coordinators on CTC files).';
comment on column public.tasks.google_tasks_sync is
  'Google Tasks for this one task: true = always send, false = never send, null = follow the project.';

-- Which tasks have a copy in someone's Google Tasks, for the mark after a
-- task's title. Task ids only: google_task_links stays readable by its owner
-- alone (it holds Google list and task ids), so without this a user would see
-- the mark on their own tasks and on nobody else's. One array rather than
-- rows, so the 1000-row response cap never cuts it short.
create or replace function public.google_synced_task_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct task_id), '{}'::uuid[]) from public.google_task_links
$$;

revoke all on function public.google_synced_task_ids() from public, anon;
grant execute on function public.google_synced_task_ids() to authenticated;
