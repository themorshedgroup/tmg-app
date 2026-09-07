-- Christie's events → Team Calendar.
--
-- Tarek receives Christie's International Real Estate mail in two shapes:
--   1. a real Google Calendar INVITE (e.g. "Toolbox Thursday"), which carries a
--      text/calendar part with exact SUMMARY / DTSTART / DTEND / RRULE, and
--   2. a plain roundup email listing several upcoming Christie's events in prose.
-- Both should end up on the shared TMG Team Calendar as "Christie's - <Event>",
-- future events only. Shape 1 is parsed deterministically from the ICS; shape 2
-- is read by Claude. Symon chose auto-create for BOTH (2026-09-05) — there is no
-- approval queue, so this table is the audit trail: every row records what was
-- created, from which email, and which Team Calendar event id it became, so a
-- bad batch can be found and deleted without hunting through the calendar.
--
-- ── Auth model (same as ctc_emails — per-user tokens, no service account) ──
-- Reading Tarek's mail reuses the Google refresh token he personally granted the
-- app (google_tokens + gmail.readonly, already requested in supabase.js). He
-- revokes app access in his own Google account and the crawl stops immediately,
-- on his authority. WRITING to the Team Calendar is the one place a service
-- account is used (GCAL_SA_*), exactly as time-off OOO events already do —
-- the calendar write must not depend on whose session triggered the run.
--
-- ── Privacy posture (mirrors ctc_emails / task_email_links) ───────────────
-- No message body is stored. Bodies are fetched live into memory when a roundup
-- email has to be read, used for that one Claude call, and dropped. What is kept
-- below is event data (title/time/place) plus the Gmail ids needed to dedupe and
-- to link back — deliberately no body column, so a later "just cache it" patch
-- has to argue with the schema first.
--
-- ── Write path: service role only ────────────────────────────────────────
-- Both tables are RLS-enabled with SELECT-only policies and NO insert/update/
-- delete policy. All writes go through the christies-events edge function on the
-- service-role key. Same reasoning as ctc_emails: an RLS-filtered UPDATE returns
-- 0 rows and no error, so a silent no-op would look like success.

-- ─── 1. Which mailboxes we crawl for Christie's mail ─────────────────────
-- Separate from ctc_mailboxes on purpose. That flag means "ingest this person's
-- correspondence into the CTC inbox"; this one means "look at this person's mail
-- for Christie's events only". Enabling one must never quietly enable the other.
create table if not exists public.christies_sources (
  user_id     uuid primary key references public.profiles(id) on delete cascade,
  -- The GOOGLE account the refresh token belongs to. Corrected from Gmail's own
  -- users/me/profile on every run, same as ctc_mailboxes.
  email       text not null,
  enabled     boolean not null default false,
  -- Optional extra Gmail search terms appended to the base Christie's query.
  query_extra text,

  last_synced_at timestamptz,
  -- Surfaced so "why did this go quiet?" is answerable without reading function
  -- logs. 'needs_connect' = the owner revoked their own Google connection.
  last_error     text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists christies_sources_email_lower_key
  on public.christies_sources (lower(email));

alter table public.christies_sources enable row level security;

-- Roster + error state belongs to admins/operations, like ctc_mailboxes.
-- profiles.access is a Postgres text[], so overlap (&&), never IN.
drop policy if exists "christies_sources_select_admin" on public.christies_sources;
create policy "christies_sources_select_admin" on public.christies_sources
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.status = 'active'
       and p.access && array['admin','operations']::text[]
  ));

-- ─── 2. Every Christie's event we put on the Team Calendar ───────────────
create table if not exists public.christies_events (
  id              uuid primary key default gen_random_uuid(),
  source_user_id  uuid references public.profiles(id) on delete set null,
  source_email    text,

  -- THE dedup key, and the reason the same event never lands twice:
  --   invite  → the ICS UID, which is stable across resends, updates and
  --             forwards, and identical in every recipient's copy.
  --   roundup → 'txt:' || sha-ish of (normalised title + start date), because a
  --             prose email has no id of its own and the same roundup often goes
  --             out weekly with the same event still listed.
  dedup_key       text not null unique,
  ics_uid         text,
  ics_sequence    integer,
  -- Set when the row describes ONE occurrence of a recurring series rather than
  -- the series itself (Google's RECURRENCE-ID). Null = the series row.
  ics_recurrence_id timestamptz,

  gmail_message_id text,
  gmail_thread_id  text,
  rfc_message_id   text,
  email_subject    text,
  email_date       timestamptz,

  -- 'invite' = parsed from a text/calendar part, exact.
  -- 'roundup' = extracted by Claude from prose, carries a confidence.
  origin          text not null check (origin in ('invite','roundup')),
  confidence      numeric,

  -- The title as it arrived, kept next to what we actually wrote, so a bad
  -- rename is diagnosable without reopening the email.
  source_title    text,
  -- The SERIES name with the week's subject removed ("Toolbox Thursday"). This
  -- is the join key between a recurring invite and the announcement email that
  -- later names that week's topic — without it the two look like two events.
  base_title      text,
  -- That week's subject. Written into the event title after the series name and
  -- as the first line of the description.
  topic           text,
  calendar_title  text,          -- "Christie's - <Event Name>: <topic>"
  starts_at       timestamptz,
  ends_at         timestamptz,
  all_day         boolean not null default false,
  time_zone       text,
  recurrence      text,          -- the RRULE line, when the invite repeats
  location        text,

  -- The event id Google gave us on the Team Calendar. Null when nothing was
  -- created (see status) — this column is how a later run patches or removes
  -- the event instead of creating a second one.
  team_event_id   text,
  status          text not null default 'created'
                    check (status in ('created','updated','instance_updated','cancelled','skipped_past','skipped_duplicate','skipped_low_confidence','error')),
  last_error      text,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- "what did the crawler do lately?" — the admin/diagnostic read.
create index if not exists christies_events_created_idx
  on public.christies_events (created_at desc);
-- The duplicate guard: same event arriving as BOTH an invite and a roundup line
-- has two different dedup_keys, so before creating anything the function looks
-- for a live event with the same series name on the same day.
create index if not exists christies_events_title_start_idx
  on public.christies_events (lower(base_title), starts_at)
  where team_event_id is not null;
-- "which live recurring series is this announcement talking about?"
create index if not exists christies_events_series_idx
  on public.christies_events (lower(base_title))
  where recurrence is not null and team_event_id is not null;
create index if not exists christies_events_uid_idx
  on public.christies_events (ics_uid) where ics_uid is not null;

alter table public.christies_events enable row level security;

-- Readable by any active user: these are company events that are already on the
-- shared Team Calendar everyone can see. Not public to anonymous.
drop policy if exists "christies_events_select_active" on public.christies_events;
create policy "christies_events_select_active" on public.christies_events
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
  ));

-- ─── 3. Emails the AI has already read ───────────────────────────────────
-- The crawl re-scans a rolling window of mail on every run, so the same
-- announcement email keeps coming back. Invites cost nothing to re-parse, but
-- re-sending prose to Claude every hour would bill the same answer ~24 times a
-- day forever. One row per Gmail message id, written only after a successful
-- call, makes AI spend a function of how much mail arrives rather than how often
-- the cron ticks. A failed call writes nothing, so it retries next run.
create table if not exists public.christies_ai_reads (
  gmail_message_id text primary key,
  source_user_id   uuid references public.profiles(id) on delete set null,
  email_subject    text,
  events_found     integer not null default 0,
  read_at          timestamptz not null default now()
);

alter table public.christies_ai_reads enable row level security;

-- Operational bookkeeping, not content — admins only, and no write policy
-- (the edge function writes it on the service-role key).
drop policy if exists "christies_ai_reads_select_admin" on public.christies_ai_reads;
create policy "christies_ai_reads_select_admin" on public.christies_ai_reads
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.status = 'active'
       and p.access && array['admin','operations']::text[]
  ));

-- ─── 4. Seed the one source Symon asked for: Tarek's mailbox ─────────────
-- Matched by first name rather than a hardcoded address, because guessing an
-- address is exactly the kind of silent substitution that ends up crawling the
-- wrong person. If this inserts 0 rows (name spelled differently, profile not
-- active), the crawler simply has nothing to do and an admin enables the right
-- profile with the function's `set_source` action — it does NOT fall back to
-- some other mailbox.
insert into public.christies_sources (user_id, email, enabled)
select p.id, p.email, true
  from public.profiles p
 where p.status = 'active'
   and lower(coalesce(p.first_name, '')) = 'tarek'
   and p.email is not null
on conflict (user_id) do nothing;
