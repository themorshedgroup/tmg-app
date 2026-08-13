-- Zoho Projects <-> TMG CTC Files two-way sync (plan: hidden-wiggling-lamport).
--
-- CTC Files are `projects` rows with record_type='ctc_file'. This migration adds
-- the linkage needed to tie a CTC file (and its tasks) to a matching project in
-- Zoho Projects — a SEPARATE Zoho product from the CRM `zoho_connection` already
-- powers, with its own portal-scoped OAuth. Deliberately a separate connection
-- table (see plan §1) rather than extending `zoho_connection`, so a Projects
-- reconnect can never risk breaking live CRM sync.
--
-- Sync is opt-in per CTC file (`projects.zoho_sync_enabled`) and only ever
-- touches record_type='ctc_file' rows — plain tasks and 'project'/'rock' rows
-- are never linked. Field scope is deliberately narrow (plan §2.1): only
-- title/description/due date/priority/status sync on tasks, and only
-- name/start/target date sync on projects — TMG's own project status stays
-- TMG-managed, never overwritten by Zoho.
--
-- Not run automatically — `supabase db push` once linked, same as this
-- project's other schema changes.

-- ── Org-wide Zoho Projects connection (service-role only, mirrors zoho_connection) ──
create table if not exists public.zoho_projects_connection (
  id                       uuid primary key default gen_random_uuid(),
  refresh_token            text not null,
  portal_id                text not null,
  api_domain               text not null default 'projectsapi.zoho.com',
  accounts_url             text not null default 'https://accounts.zoho.com',
  access_token             text,
  access_token_expires_at  timestamptz,
  connected_by             uuid references public.profiles(id) on delete set null,
  connected_at             timestamptz not null default now()
);

alter table public.zoho_projects_connection enable row level security;
-- No policies for `authenticated` — this row is only ever read/written by the
-- service-role client inside the zoho-projects edge function, same posture as
-- zoho_connection. RLS-enabled-with-no-policies denies all normal-user access.

-- ── Conflict audit trail (plan §5) ──
create table if not exists public.zoho_sync_conflicts (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid references public.tasks(id) on delete cascade,
  project_id   uuid references public.projects(id) on delete cascade,
  field        text not null,
  tmg_value    text,
  zoho_value   text,
  resolution   text not null check (resolution in ('tmg_won', 'zoho_won')),
  detected_at  timestamptz not null default now(),
  resolved_at  timestamptz not null default now()
);

create index if not exists zoho_sync_conflicts_task_id_idx on public.zoho_sync_conflicts(task_id);

alter table public.zoho_sync_conflicts enable row level security;

-- Any active TMG profile can read the conflict log (visibility for the TC/ops
-- team); only the service role (edge function) ever writes to it.
create policy "zoho_sync_conflicts_select_active" on public.zoho_sync_conflicts
  for select to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active'));

-- ── Linkage columns on the existing tables ──
alter table public.projects
  add column if not exists zoho_project_id text,
  add column if not exists zoho_tasklist_id text,
  add column if not exists zoho_last_synced_at timestamptz,
  add column if not exists zoho_sync_enabled boolean not null default false;

alter table public.tasks
  add column if not exists zoho_task_id text,
  add column if not exists zoho_last_synced_at timestamptz,
  add column if not exists zoho_last_modified_time bigint;

create index if not exists projects_zoho_project_id_idx on public.projects(zoho_project_id) where zoho_project_id is not null;
create index if not exists tasks_zoho_task_id_idx on public.tasks(zoho_task_id) where zoho_task_id is not null;
