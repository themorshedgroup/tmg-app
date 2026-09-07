-- Who actually submitted each health goal.
--
-- Zoho records the API connection as the creator of everything the app
-- writes, so a goal saved through the app carries no trace of its author. In
-- September three goals were filed under the wrong owner and the only way to
-- recover who wrote them was Supabase's edge-function logs -- which keep about
-- two days. One of the three had already aged out and needed a human to
-- remember it.
--
-- This is the permanent record: written by the edge function at save time,
-- using the caller's own session, so it cannot be spoofed by the client.

create table if not exists public.health_goal_submissions (
  zoho_id           text        primary key,
  submitted_by      uuid        references auth.users (id) on delete set null,
  submitted_by_name text,
  submitted_at      timestamptz not null default now()
);

alter table public.health_goal_submissions enable row level security;

-- Readable by the team, same as the goals themselves.
drop policy if exists "signed-in read health goal submissions" on public.health_goal_submissions;
create policy "signed-in read health goal submissions"
  on public.health_goal_submissions for select to authenticated using (true);

-- No client write policy on purpose: only the edge function (service role,
-- which bypasses RLS) stamps these, so the attribution is trustworthy.

-- Backfill for September 2026, the month this problem surfaced. The first two
-- were read from the edge-function logs (auth_user on the request that created
-- them); the last two are Symon's own account of them. Nothing earlier can be
-- recovered -- those goals were entered in Zoho directly, where the real author
-- is already the owner.
insert into public.health_goal_submissions (zoho_id, submitted_by, submitted_by_name, submitted_at) values
  ('6597827000021222001', 'af94a9f3-50d5-4497-9d87-0069ad17673b', 'Angelica Morales',  '2026-09-04T17:42:41Z'),
  ('6597827000021215001', 'e7d88fa2-6339-4a15-a7ca-99219d93b641', 'Camila Sepúlveda',  '2026-09-04T00:55:35Z'),
  ('6597827000021214002', '42f45158-2cfb-4045-bf8d-2553e19b7dc6', 'Gustavo Hernandez', '2026-09-03T17:49:19Z'),
  ('6597827000021210001', 'ecf054fd-1427-445f-b4c9-4014a43078d8', 'Symon Yongco',      '2026-09-03T09:49:13Z')
on conflict (zoho_id) do nothing;
