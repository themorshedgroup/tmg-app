-- ─────────────────────────────────────────────────────────────────────────
-- Google Tasks two-way sync.
--
-- Two directions, one mechanism:
--   OUT  a TMG task that is ASSIGNED to someone shows up in that person's
--        Google Tasks, so agents see their work on their phone without
--        opening the app. A task with nobody on it stays put — a CTC file's
--        checklist is a shared pool until someone picks an item up.
--   IN   a checklist item assigned to someone inside a monthly meeting agenda
--        already becomes a real Google Task; Google Docs does that itself.
--        We read those back and file them under that person's My Tasks.
--
-- Nothing reads the documents and no AI is involved. The only thing that
-- identifies an agenda task is the Drive file id Google stamps on it
-- (Task.assignmentInfo.driveResourceInfo.driveFileId). A task without a
-- drive_file_id listed in agenda_docs is skipped and never stored, so
-- people's private Google Tasks stay private.
-- ─────────────────────────────────────────────────────────────────────────

-- The meeting agendas whose assigned checkboxes belong in the app.
create table if not exists public.agenda_docs (
  id            uuid primary key default gen_random_uuid(),
  drive_file_id text        not null unique,
  name          text,
  url           text,
  active        boolean     not null default true,
  created_at    timestamptz not null default now()
);

-- One row per (TMG task, person) pair that exists on both sides.
create table if not exists public.google_task_links (
  task_id        uuid        not null references public.tasks(id)    on delete cascade,
  user_id        uuid        not null references public.profiles(id) on delete cascade,
  google_task_id text        not null,
  google_list_id text        not null,
  -- 'push' = we created it in Google from a TMG task
  -- 'pull' = it arrived from an agenda doc and we created the TMG task
  origin         text        not null default 'push',
  drive_file_id  text,
  -- what we last sent to Google, so a later run can tell a real change from
  -- a no-op and skip the write
  last_pushed    jsonb,
  google_updated timestamptz,
  synced_at      timestamptz not null default now(),
  primary key (task_id, user_id)
);
-- A Google task belongs to exactly one TMG task per person — this is what
-- stops a hiccup mid-run from creating the same task twice.
create unique index if not exists google_task_links_google_uniq
  on public.google_task_links (user_id, google_task_id);

-- Per-person cursor + the numbers the app's sync panel shows.
create table if not exists public.google_tasks_sync_state (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  cursor_at   timestamptz,          -- updatedMin for the next poll
  last_run_at timestamptz,
  last_ok_at  timestamptz,
  pushed      integer not null default 0,
  pulled      integer not null default 0,
  last_error  text
);

alter table public.agenda_docs             enable row level security;
alter table public.google_task_links       enable row level security;
alter table public.google_tasks_sync_state enable row level security;

-- The client only ever READS these; every write is the service role inside
-- the google-tasks-sync function.
drop policy if exists agenda_docs_read on public.agenda_docs;
create policy agenda_docs_read on public.agenda_docs for select
  using (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.status = 'active'));

drop policy if exists agenda_docs_admin_write on public.agenda_docs;
create policy agenda_docs_admin_write on public.agenda_docs for all
  using (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.status = 'active'
                   and p.access && array['admin','operations']::text[]))
  with check (exists (select 1 from public.profiles p
                 where p.id = auth.uid() and p.status = 'active'
                   and p.access && array['admin','operations']::text[]));

drop policy if exists google_task_links_own on public.google_task_links;
create policy google_task_links_own on public.google_task_links for select
  using (user_id = auth.uid());

drop policy if exists google_tasks_sync_state_own on public.google_tasks_sync_state;
create policy google_tasks_sync_state_own on public.google_tasks_sync_state for select
  using (user_id = auth.uid());

-- The four agendas Symon named on 2026-09-10. Titles read from Drive.
insert into public.agenda_docs (drive_file_id, name, url) values
  ('1tQMWOI0gmDUEXpVuweCRg_UFWsFGirxVah2XpNVl7r8', 'TMG Operations Agendas',     'https://docs.google.com/document/d/1tQMWOI0gmDUEXpVuweCRg_UFWsFGirxVah2XpNVl7r8/edit'),
  ('17oZQq21NX0JyVzAGDCPjVqZ9mxp1b3BkYXHwwxsapDA', 'TMG Monthly Meeting Agenda', 'https://docs.google.com/document/d/17oZQq21NX0JyVzAGDCPjVqZ9mxp1b3BkYXHwwxsapDA/edit'),
  ('1WgHmGLUfkaZs4bVvZrhonn_qej5tBbmP_QnZS-9xuoU', 'Sales Meeting Agenda',       'https://docs.google.com/document/d/1WgHmGLUfkaZs4bVvZrhonn_qej5tBbmP_QnZS-9xuoU/edit'),
  ('1j-81kwbf_3_HoLzUaNmNQGRhaOR3W_0vT6paVhFbG8c', 'EO Agenda 2026',             'https://docs.google.com/document/d/1j-81kwbf_3_HoLzUaNmNQGRhaOR3W_0vT6paVhFbG8c/edit')
on conflict (drive_file_id) do nothing;
