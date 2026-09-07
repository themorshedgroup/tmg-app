-- Who submitted each Zoho record the app creates -- now for any module, not
-- just health goals.
--
-- Zoho names the API connection as the creator of everything the app writes,
-- so an app-created record carries no trace of its author. Agent KPIs have the
-- same blind spot health goals did: when one lands under the wrong owner,
-- there is nothing to check afterwards.
--
-- Replaces health_goal_submissions (created two migrations ago, four rows,
-- nothing deployed against it yet) rather than adding a second near-identical
-- table beside it.

create table if not exists public.zoho_submissions (
  module            text        not null,
  zoho_id           text        not null,
  submitted_by      uuid        references auth.users (id) on delete set null,
  submitted_by_name text,
  submitted_at      timestamptz not null default now(),
  primary key (module, zoho_id)
);

alter table public.zoho_submissions enable row level security;

drop policy if exists "signed-in read zoho submissions" on public.zoho_submissions;
create policy "signed-in read zoho submissions"
  on public.zoho_submissions for select to authenticated using (true);

-- No client write policy on purpose: only the edge function (service role,
-- which bypasses RLS) stamps these, so the attribution can be trusted.

insert into public.zoho_submissions (module, zoho_id, submitted_by, submitted_by_name, submitted_at)
select 'Health_Goals', zoho_id, submitted_by, submitted_by_name, submitted_at
from public.health_goal_submissions
on conflict (module, zoho_id) do nothing;

drop table if exists public.health_goal_submissions;
