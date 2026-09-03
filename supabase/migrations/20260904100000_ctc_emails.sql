-- CTC Emails — one consolidated inbox across Sales Agent + Transaction
-- Coordinator mailboxes, with an AI-SUGGESTED CTC file match and a drafted
-- Overview note that a human approves. Nothing is ever auto-applied.
--
-- Schema is written to match supabase/functions/ctc-emails/index.ts exactly;
-- that function is the only writer. If you change a column name here, change
-- it there in the same commit.
--
-- ── Auth model (per-user tokens, NOT a service account) ───────────────
-- Polling reuses the Google refresh tokens the app already stores per user in
-- google_tokens (supabase.js already requests gmail.readonly inside
-- connectCalendar(), and google-calendar's token mint works with no user
-- present — exactly what a cron poller needs). So: no domain-wide delegation,
-- no Google Admin console change, no new scope. A person's mail is readable
-- only while they personally have the app connected, and revoking Google
-- access in their own account stops it immediately, on their authority.
--
-- A mailbox is polled ONLY when all three hold, re-checked every run:
--   1. an admin set ctc_mailboxes.enabled = true (this flag is the authority;
--      profiles.access containing 'agent'/'tc' only SUGGESTS the roster),
--   2. the owner still has a live google_tokens row,
--   3. the owner's profile is still active.
--
-- ── Privacy posture (mirrors task_email_links) ────────────────────────
-- No message BODY is stored anywhere. Only From/To/Subject/date and Gmail's
-- own snippet are cached — enough to render a row. When the triage model needs
-- more, the body is fetched live into memory for that one call and dropped.
-- There is deliberately no body column below, so a later "just cache it, it's
-- faster" patch has to argue with the schema first.
--
-- ── Write path: service role only ─────────────────────────────────────
-- Every table here is RLS-enabled with SELECT-only policies and NO
-- insert/update/delete policy. All writes go through the ctc-emails edge
-- function on the service-role key. This is deliberate: a Supabase UPDATE that
-- RLS filters out returns 0 rows and NO error, so an approve button would look
-- like it worked and silently persist nothing. With no write policy at all, a
-- stray client write raises 42501 instead of being quietly dropped.

-- ─── 1. Mailboxes we may poll ────────────────────────────────────────
create table if not exists public.ctc_mailboxes (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  -- The GOOGLE account the refresh token belongs to, not necessarily the TMG
  -- profile address. The poller corrects this from Gmail's own users/me/profile
  -- on every run, because every Gmail permalink is pinned to it via ?authuser=.
  email        text not null,
  enabled      boolean not null default false,
  -- Optional extra Gmail search terms per mailbox, appended to the base query.
  query_extra  text,

  -- Cursor state. Split in three so a crash mid-listing loses nothing:
  --   cursor_epoch_s      high-water mark that is SAFE to resume from.
  --   sweep_high_epoch_s  candidate high-water mark for the walk in progress;
  --                       promoted into cursor_epoch_s only when the walk ends.
  --   sweep_page_token    Gmail's nextPageToken. Non-null means the last run
  --                       stopped mid-listing and the next run MUST resume here
  --                       before advancing anything.
  -- Date-based rather than Gmail historyId on purpose: a historyId expires
  -- after about a week, and this poller is allowed to fall behind. A stale
  -- historyId fails in a way that silently skips mail — the exact bug class
  -- this layout exists to prevent.
  cursor_epoch_s      bigint,
  sweep_high_epoch_s  bigint,
  sweep_page_token    text,

  last_polled_at  timestamptz,
  -- Surfaced in the admin panel so "why did this mailbox go quiet?" is
  -- answerable without reading function logs. 'needs_connect' = the owner
  -- revoked or never completed their own Google connection.
  last_error      text,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Gmail addresses are case-insensitive; profile casing is whatever Google gave.
create unique index if not exists ctc_mailboxes_email_lower_key
  on public.ctc_mailboxes (lower(email));
-- The poller's only lookup: "which mailboxes may I read?"
create index if not exists ctc_mailboxes_enabled_idx
  on public.ctc_mailboxes (enabled) where enabled = true;

alter table public.ctc_mailboxes enable row level security;

-- Admin/operations only: this table is roster + cursor + error state, which
-- belongs to the admin panel. The Emails tab never needs it — ctc_emails
-- carries mailbox_email inline.
-- profiles.access is a Postgres text[], so overlap (&&), never IN.
drop policy if exists "ctc_mailboxes_select_admin" on public.ctc_mailboxes;
create policy "ctc_mailboxes_select_admin" on public.ctc_mailboxes
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid()
       and p.status = 'active'
       and p.access && array['admin','operations']::text[]
  ));

-- ─── 2. The consolidated email list ──────────────────────────────────
create table if not exists public.ctc_emails (
  id                uuid primary key default gen_random_uuid(),
  mailbox_user_id   uuid not null references public.profiles(id) on delete cascade,
  mailbox_email     text not null,

  -- THE dedup key. An agent and a TC on the same lender thread receive the
  -- same message; Gmail's own message id is per-mailbox and would give us two
  -- rows, two AI calls and two competing suggestions for one email. The RFC822
  -- Message-ID header is stable across mailboxes, so first mailbox in wins and
  -- the rest are recorded in also_seen_in.
  rfc_message_id    text not null unique,
  gmail_message_id  text,
  gmail_thread_id   text,
  -- Other mailboxes that also received this exact message.
  also_seen_in      text[] not null default '{}',

  from_addr    text,
  from_name    text,
  to_addr      text,
  subject      text,
  snippet      text,          -- Gmail's own ~200 char snippet. NOT the body.
  email_date   timestamptz,
  -- Gmail's own internalDate, kept raw so ordering never drifts on timezone
  -- conversion (same reasoning as zoho_last_modified_time on tasks).
  internal_date_ms  bigint,
  -- https://mail.google.com/mail/?authuser=<owner>#all/<thread>. Only resolves
  -- for that owner: Gmail thread ids are per-mailbox, so this link is useful to
  -- the person who received it, not to everyone reading the tab.
  permalink    text,

  status       text not null default 'new'
                 check (status in ('new','suggested','no_match','approved','rejected')),

  -- What the AI proposed. Never applied on its own.
  suggested_project_id   uuid references public.projects(id) on delete set null,
  suggested_note         text,
  suggested_confidence   numeric,
  suggested_reason       text,
  triaged_at             timestamptz,

  -- What a human decided.
  linked_project_id  uuid references public.projects(id) on delete set null,
  approved_note      text,
  rejected_reason    text,
  decided_by         uuid references public.profiles(id) on delete set null,
  decided_at         timestamptz,

  created_at   timestamptz not null default now()
);

-- Deliberately NO "linked rows must have a project" check constraint: combined
-- with `on delete set null` it makes deleting a CTC file impossible — the FK
-- nulls the column, the check re-evaluates on the half-updated row, raises
-- 23514, and the parent DELETE aborts.

-- The tab's default read: newest first, optionally filtered by triage state.
create index if not exists ctc_emails_status_date_idx
  on public.ctc_emails (status, email_date desc);
create index if not exists ctc_emails_date_idx
  on public.ctc_emails (email_date desc);
-- "show me everything filed against this CTC file"
create index if not exists ctc_emails_linked_idx
  on public.ctc_emails (linked_project_id) where linked_project_id is not null;
-- The poller's per-run dedup lookup.
create index if not exists ctc_emails_mailbox_idx
  on public.ctc_emails (mailbox_user_id, email_date desc);

alter table public.ctc_emails enable row level security;

-- Readable by any active user. This is staff mail metadata, so it is
-- deliberately NOT public to anonymous, and never carries a body.
drop policy if exists "ctc_emails_select_active" on public.ctc_emails;
create policy "ctc_emails_select_active" on public.ctc_emails
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
  ));

-- ─── 3. Approved Overview updates ────────────────────────────────────
-- Their own table, NOT projects.outcome: that column is rendered in three
-- separate views, and appending running notes to it would wreck all three.
create table if not exists public.project_updates (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  body         text not null,
  -- 'email' today; leaves room for a manual or automated update later without
  -- another table.
  source           text not null default 'email',
  source_email_id  uuid references public.ctc_emails(id) on delete set null,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists project_updates_project_idx
  on public.project_updates (project_id, created_at desc);

alter table public.project_updates enable row level security;

drop policy if exists "project_updates_select_active" on public.project_updates;
create policy "project_updates_select_active" on public.project_updates
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
  ));
