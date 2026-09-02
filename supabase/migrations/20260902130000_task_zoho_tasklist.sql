-- Zoho Projects tasks carry their tasklist (e.g. "Pre-List", "Clear to
-- Close") directly on the task object (t.tasklist.{id,name}) — no extra API
-- call needed. Stored denormalized on tasks so the app can group a synced
-- CTC file/project's task list by tasklist without a live Zoho round trip.
alter table public.tasks add column if not exists zoho_tasklist_id text;
alter table public.tasks add column if not exists zoho_tasklist_name text;
create index if not exists idx_tasks_zoho_tasklist on public.tasks(project_id, zoho_tasklist_id) where zoho_tasklist_id is not null;
