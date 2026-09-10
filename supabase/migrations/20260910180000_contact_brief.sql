-- Contact summary (the (i) on a Calls-tab row): who may be read, and who read whom.
--
-- Tapping (i) generates a short brief before a call. Part of that brief comes
-- from a LIVE Gmail search of the OWNING AGENT's mailbox and that agent's
-- assigned transaction coordinator's -- not the viewer's. Symon approved that
-- read. Nothing about the brief is stored anywhere; these two tables are the
-- consent switch and the access log, and neither holds a subject, a snippet or
-- a body.

-- ── Who may have their mailbox read ──────────────────────────────────────
-- Deliberately SEPARATE from ctc_mailboxes and christies_sources. Those mean
-- "ingest this person's correspondence" and "scan this mailbox for Christie's
-- events". This one means "a colleague may read a few of this person's threads
-- about a contact they own". Switching one on must never quietly switch on
-- another (same rule as 20260905120000_christies_events.sql).
--
-- Why a switch at all, when the read is approved: somebody who connected Google
-- so their calendar would sync never agreed to a colleague reading their mail,
-- and the only way to opt out WITHOUT this table is disconnecting Google —
-- which would break their calendar too. One row per person, flipped by SQL.
create table if not exists public.brief_mailboxes (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  enabled    boolean not null default false,
  updated_at timestamptz not null default now()
);

comment on table public.brief_mailboxes is
  'Per-person consent for the Calls-tab contact summary to search this person''s Gmail. enabled=false means their mailbox is skipped and the brief says so.';
comment on column public.brief_mailboxes.enabled is
  'ON means: this person''s assigned TC, and any admin/operations user, may have up to a few of this person''s email threads about a contact this person owns summarised by AI. It does NOT open the mailbox itself — no subjects, addresses, thread ids or bodies ever reach the viewer.';

-- Seeded ON for everyone active today, which is what makes the feature work on
-- day one. Flip anyone off with:
--   update public.brief_mailboxes set enabled = false, updated_at = now()
--   where user_id = (select id from public.profiles where email = 'name@themorshedgroup.com');
insert into public.brief_mailboxes (user_id, enabled)
select id, true from public.profiles where status = 'active'
on conflict (user_id) do nothing;

-- ── Who read whose mailbox ───────────────────────────────────────────────
-- Reading a colleague's mail on a button press needs a trail. There is NO
-- subject, snippet or body column here on purpose, so a later "let's just cache
-- the brief" patch has to argue with the schema before it can store anything.
create table if not exists public.contact_brief_reads (
  id             bigserial primary key,
  viewer_id      uuid not null references public.profiles(id),
  contact_id     text not null,
  agent_id       uuid,
  tc_id          uuid,
  mailboxes_read text[] not null default '{}',
  threads_read   int not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists contact_brief_reads_viewer_time
  on public.contact_brief_reads (viewer_id, created_at desc);

comment on table public.contact_brief_reads is
  'One row per contact-summary generation. Records WHO looked and WHOSE mailboxes were searched -- never what was in them. Also the source of the per-viewer hourly rate limit.';

alter table public.brief_mailboxes      enable row level security;
alter table public.contact_brief_reads  enable row level security;

-- Every write goes through the edge function on the service-role key, so
-- neither table gets an insert/update/delete policy.
--
-- Anyone may see whether their OWN mailbox is switched on -- that is the point
-- of a consent switch. Admins see the whole roster.
drop policy if exists brief_mailboxes_select on public.brief_mailboxes;
create policy brief_mailboxes_select on public.brief_mailboxes
  for select to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        -- profiles.access is text[]: overlap, never IN.
        and p.access && array['admin', 'operations']
    )
  );

-- The access log is admin-only. It records which contacts each person looked
-- up, which is itself sensitive -- an agent should not be able to read which
-- clients an admin briefed on.
drop policy if exists contact_brief_reads_select on public.contact_brief_reads;
create policy contact_brief_reads_select on public.contact_brief_reads
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.access && array['admin', 'operations']
    )
  );
