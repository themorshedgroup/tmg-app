-- ─────────────────────────────────────────────────────────────────────────
-- Agenda to-dos → the Accountability Dashboard in Zoho Projects
--
-- The chain was built in three hops and only two of them worked:
--   1. Google Doc checkbox → the assignee's Google Tasks   (native Google)
--   2. Google Tasks → TMG app                              (google-tasks-sync,
--                                                            pg_cron, 15 min)
--   3. TMG app → Zoho Projects                             (never happened)
--
-- Hop 3 failed because google-tasks-sync inserted imported agenda tasks with
-- no project_id (it deliberately avoided "inventing a project"), and
-- zoho-projects-poll only ever touches tasks that belong to a project with
-- zoho_sync_enabled = true and a zoho_project_id. No project meant no push.
--
-- This migration gives every agenda the project its to-dos belong to, and
-- back-fills the ones already imported so they are not stranded. The matching
-- code change is in google-tasks-sync (sets project_id on insert) and in
-- zoho-projects-poll (creates Zoho tasks for TMG tasks Zoho has never seen).
-- ─────────────────────────────────────────────────────────────────────────

alter table public.agenda_docs
  add column if not exists project_id uuid references public.projects(id) on delete set null;

comment on column public.agenda_docs.project_id is
  'The TMG project imported to-dos from this agenda belong to. When that project is linked to Zoho (zoho_sync_enabled + zoho_project_id), zoho-projects-poll carries them into Zoho Projects.';

-- All four agendas feed the one Accountability Dashboard. Resolved by the Zoho
-- project id (TH-10) rather than by name, so a rename in the app cannot
-- silently point this at the wrong project.
update public.agenda_docs a
   set project_id = p.id
  from public.projects p
 where p.zoho_project_id = '2435905000000202003'
   and a.project_id is distinct from p.id;

-- Back-fill the to-dos already imported before this change. Matched on the
-- provenance google-tasks-sync writes into tasks.context (the agenda's name),
-- and only where nothing has claimed the task yet: no project, and Zoho has
-- never seen it. Anything already in Zoho is left exactly as it is.
update public.tasks t
   set project_id = a.project_id
  from public.agenda_docs a
 where t.context = a.name
   and a.project_id is not null
   and t.project_id is null
   and t.zoho_task_id is null;
