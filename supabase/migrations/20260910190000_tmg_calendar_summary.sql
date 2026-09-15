-- Team Calendar Summary email (all TMG team members, every Thursday for the
-- coming Mon-Sun + every last day of the month for the coming month) and its
-- one-click RSVP tracking. See supabase/functions/tmg-calendar-summary/index.ts
-- and src/rsvp.jsx (the landing page a Yes/No/Maybe link opens).

-- ── RSVPs: one row per (event, person). Unlike tmg_meeting_notices/
-- tmg_task_digests, this is the PERSON'S OWN data, not Symon's — a user may
-- read and write only their own row. No service-role-only gate here; rsvp.jsx
-- writes directly under RLS using the logged-in session, no signed token.
create table if not exists public.tmg_event_rsvps (
  google_event_id text not null,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  response        text not null check (response in ('yes', 'no', 'maybe')),
  responded_at    timestamptz not null default now(),
  primary key (google_event_id, profile_id)
);

alter table public.tmg_event_rsvps enable row level security;

drop policy if exists "tmg_event_rsvps_own_select" on public.tmg_event_rsvps;
create policy "tmg_event_rsvps_own_select" on public.tmg_event_rsvps
  for select to authenticated
  using (
    profile_id = auth.uid()
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.status = 'active' and p.access && array['admin']::text[])
  );

drop policy if exists "tmg_event_rsvps_own_write" on public.tmg_event_rsvps;
create policy "tmg_event_rsvps_own_write" on public.tmg_event_rsvps
  for all to authenticated
  using (profile_id = auth.uid())
  with check (profile_id = auth.uid());

-- ── Send ledger: one row per period actually sent, so a retried cron tick
-- (or a manual "send now") never double-sends the same week/month to the
-- whole team. period_key is 'YYYY-Www' for weekly, 'YYYY-MM' for monthly.
create table if not exists public.tmg_calendar_summary_log (
  send_type    text not null check (send_type in ('weekly', 'monthly')),
  period_key   text not null,
  event_count  integer not null default 0,
  sent_at      timestamptz not null default now(),
  primary key (send_type, period_key)
);

alter table public.tmg_calendar_summary_log enable row level security;

drop policy if exists "tmg_calendar_summary_log_select_admin" on public.tmg_calendar_summary_log;
create policy "tmg_calendar_summary_log_select_admin" on public.tmg_calendar_summary_log
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active' and p.access && array['admin']::text[]
  ));
