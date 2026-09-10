-- TMG internal notifications, delivered by email to Symon only (his call,
-- 2026-09-08): "Priorities Focus Time"-style meeting notices when Tarek books
-- with an operations-access team member, and an end-of-day digest of tasks
-- completed that day, grouped by who did them.
--
-- Sender identity: operations@themorshedgroup.com, via the SAME service
-- account that already writes Team Calendar OOO events (GCAL_SA_*) — one
-- additional scope (gmail.send) authorized in Google Admin for that same
-- client id, impersonating operations@ specifically for this purpose. No new
-- secret, no new account. See supabase/functions/tmg-notify/index.ts header.
--
-- ── Ledger: which meetings have already been notified ─────────────────────
-- The calendar is re-scanned on every run (no cursor, same reasoning as the
-- Christie's crawler: a missed tick costs nothing). Without this table the
-- same meeting would re-notify every run. Keyed on the Google event id; a
-- start-time change is treated as worth a fresh notice (re-notify), tracked
-- via notified_start_at so a reschedule is caught but an untouched meeting
-- is not re-sent.
create table if not exists public.tmg_meeting_notices (
  google_event_id   text primary key,
  event_summary     text,
  event_start       timestamptz,
  event_end         timestamptz,
  all_day           boolean not null default false,
  time_zone         text,
  location          text,
  html_link         text,
  organizer_name    text,
  organizer_email   text,
  -- Operations-access attendee(s) that made this notice-worthy, plain text
  -- for the email body — not a join, so a since-deactivated profile still
  -- reads correctly in old notices.
  attendee_names    text,
  notified_at       timestamptz not null default now(),
  -- The event's start at the time we last notified. Compared against the
  -- CURRENT start on every run — a mismatch means "reschedule", not "new".
  notified_start_at timestamptz,
  created_at        timestamptz not null default now()
);

create index if not exists tmg_meeting_notices_start_idx
  on public.tmg_meeting_notices (event_start);

alter table public.tmg_meeting_notices enable row level security;

-- Admin-only: this is Symon's own notification history, not team-visible data.
drop policy if exists "tmg_meeting_notices_select_admin" on public.tmg_meeting_notices;
create policy "tmg_meeting_notices_select_admin" on public.tmg_meeting_notices
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active' and p.access && array['admin']::text[]
  ));

-- ── Ledger: which day's task digest has already gone out ──────────────────
-- One row per calendar day (America/Chicago), so a cron that fires twice in
-- one evening (retry, manual "send now") never double-sends.
create table if not exists public.tmg_task_digests (
  digest_date   date primary key,
  tasks_count   integer not null default 0,
  people_count  integer not null default 0,
  sent_at       timestamptz not null default now()
);

alter table public.tmg_task_digests enable row level security;

drop policy if exists "tmg_task_digests_select_admin" on public.tmg_task_digests;
create policy "tmg_task_digests_select_admin" on public.tmg_task_digests
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active' and p.access && array['admin']::text[]
  ));
