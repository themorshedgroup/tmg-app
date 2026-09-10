-- ─────────────────────────────────────────────────────────────────────────
-- Per-agent capacity for the Cadence Health reschedule packer.
--
-- "Per day" and "EO / week" used to be plain useState defaults inside
-- Cadence Health (5 and 3), same number for whichever agent was selected,
-- reset to the default every page load. Symon kept re-typing them per
-- agent. This makes the number permanent and agent-specific; Cadence
-- Health now reads/writes it instead of owning it.
--
-- Keyed by owner NAME, not an id — that's the only identifier the packer
-- has (Zoho task Owner.name), and there's no agents table this can join
-- against yet.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.agent_cadence_settings (
  owner_name  text primary key,
  per_day     integer not null default 5,
  eo_per_week integer not null default 3,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

alter table public.agent_cadence_settings enable row level security;
-- Mirrors project_tasklist_order: any signed-in TMG account reads and
-- writes. This is an internal ops tool, not per-agent-locked data.
drop policy if exists acs_rw on public.agent_cadence_settings;
create policy acs_rw on public.agent_cadence_settings
  for all to authenticated
  using (auth.uid() is not null) with check (auth.uid() is not null);
grant select, insert, update, delete on public.agent_cadence_settings to authenticated;
