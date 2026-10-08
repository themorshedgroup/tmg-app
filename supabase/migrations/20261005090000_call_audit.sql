-- Call audit: transcripts of Tarek's calls with Operations, pulled by the
-- call-audit edge function using Tarek's own Google grant (the Tarek-only
-- "Call audit" row in Calendar Settings adds view-only Drive to it).
--
-- Meet saves a transcript in the HOST's Drive, but attaches the link to the
-- calendar event for every invited TMG person. So the reliable source is the
-- attachments on Tarek's calendar events, read with his access.
--
-- Transcripts are sensitive: no app user reads this table. RLS is on with no
-- policies, and anon/authenticated get nothing; only the service role (the
-- edge function, and SQL run by an admin) can touch it.
--
-- The function is called without a user session (from SQL via pg_net), so it
-- checks its bearer against a vault secret through call_audit_secret_ok().
-- The secret is created once in SQL with gen_random_bytes and never leaves the
-- database, so no one has to copy it anywhere:
--   select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'call_audit_secret', 'call-audit edge fn');

create table if not exists public.call_audit_items (
  id           bigserial primary key,
  event_id     text not null,
  event_title  text,
  event_start  timestamptz,
  organizer    text,
  attendees    text[] not null default '{}',
  ops_present  text[] not null default '{}',
  file_id      text not null,
  file_title   text,
  mime_type    text,
  content      text,
  chars        integer,
  fetch_error  text,
  fetched_at   timestamptz not null default now(),
  unique (event_id, file_id)
);

alter table public.call_audit_items enable row level security;
revoke all on public.call_audit_items from anon, authenticated;
grant all on public.call_audit_items to service_role;
grant usage, select on sequence public.call_audit_items_id_seq to service_role;

create or replace function public.call_audit_secret_ok(p text)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'call_audit_secret' and decrypted_secret = p
  );
$$;

revoke execute on function public.call_audit_secret_ok(text) from public, anon, authenticated;
grant execute on function public.call_audit_secret_ok(text) to service_role;
