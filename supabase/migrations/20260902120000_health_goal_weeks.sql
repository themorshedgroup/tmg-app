-- Health Goals: weekly achieved/not-achieved ticks.
--
-- The goals themselves live in Zoho's Health_Goals module (owner, goal text,
-- month, status) -- that module has no per-week fields, so the week ticks are
-- app-only and live here, keyed by the Zoho record id.

create table if not exists public.health_goal_weeks (
  zoho_id    text        not null,
  week       smallint    not null check (week between 1 and 6),
  done       boolean     not null default false,
  updated_by uuid        references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (zoho_id, week)
);

alter table public.health_goal_weeks enable row level security;

-- Shared like the goals themselves: the whole team sees everyone's progress.
drop policy if exists "signed-in read health goal weeks" on public.health_goal_weeks;
create policy "signed-in read health goal weeks"
  on public.health_goal_weeks for select to authenticated using (true);

drop policy if exists "signed-in insert health goal weeks" on public.health_goal_weeks;
create policy "signed-in insert health goal weeks"
  on public.health_goal_weeks for insert to authenticated with check (true);

drop policy if exists "signed-in update health goal weeks" on public.health_goal_weeks;
create policy "signed-in update health goal weeks"
  on public.health_goal_weeks for update to authenticated using (true) with check (true);
