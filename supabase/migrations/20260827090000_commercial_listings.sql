-- Commercial Listings: crawled Austin inventory + agent-curated client lists.
--
-- Reads are restricted to signed-in users, not `anon`. The app's publishable key
-- ships in a public repo, so an `anon` read policy would put every listing --
-- including brokers' agent phone numbers -- on the open web.

-- ── Crawled inventory (machine-owned; never edited by hand) ──────────
create table if not exists public.listings (
  id            text primary key,              -- stable hash of url|name|broker
  broker        text not null,
  name          text,
  address       text,
  city          text,
  submarket     text,
  property_type text,                          -- office|retail|industrial|land|multifamily|mixed|other
  status        text,                          -- for_lease|for_sale|both
  size          text,
  price_or_rate text,
  agents        jsonb not null default '[]'::jsonb,
  url           text,
  image_url     text,
  source        text,                          -- scraper key (ecr, aquila, costar, ...)
  first_seen    date not null default current_date,
  last_seen     date not null default current_date,
  is_new        boolean not null default true,
  active        boolean not null default true, -- false = no longer listed (never hard-deleted)
  raw           jsonb,
  updated_at    timestamptz not null default now()
);

create index if not exists listings_active_idx  on public.listings (active, broker, property_type);
create index if not exists listings_lastseen_idx on public.listings (last_seen desc);

create table if not exists public.crawl_runs (
  id     bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  totals jsonb,
  notes  jsonb
);

-- ── Client folders (human-owned; shared across all agents) ───────────
create table if not exists public.listing_clients (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  notes       text,
  criteria    jsonb not null default '{}'::jsonb,  -- saved search parameters
  archived    boolean not null default false,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists listing_clients_active_idx on public.listing_clients (archived, name);

-- Listings an agent deliberately saved to a client.
-- snapshot keeps what was shown even after the listing leaves the market.
create table if not exists public.listing_client_items (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references public.listing_clients (id) on delete cascade,
  listing_id text not null,
  note       text,
  snapshot   jsonb,
  added_by   uuid references auth.users (id) on delete set null,
  added_at   timestamptz not null default now(),
  unique (client_id, listing_id)
);

create index if not exists lci_client_idx on public.listing_client_items (client_id, added_at desc);

-- ── Per-user table layout (column order + visibility + widths) ───────
create table if not exists public.listing_column_prefs (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  columns    jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

-- ── Row Level Security ──────────────────────────────────────────────
alter table public.listings             enable row level security;
alter table public.crawl_runs           enable row level security;
alter table public.listing_clients      enable row level security;
alter table public.listing_client_items enable row level security;
alter table public.listing_column_prefs enable row level security;

-- Inventory: signed-in users read active rows. Writes are service-role only
-- (the crawler), which bypasses RLS -- so no write policy is defined here.
drop policy if exists "signed-in read active listings" on public.listings;
create policy "signed-in read active listings"
  on public.listings for select to authenticated
  using (active = true);

drop policy if exists "signed-in read crawl runs" on public.crawl_runs;
create policy "signed-in read crawl runs"
  on public.crawl_runs for select to authenticated
  using (true);

-- Client folders are shared: any signed-in agent may read and maintain them.
drop policy if exists "signed-in read clients" on public.listing_clients;
create policy "signed-in read clients"
  on public.listing_clients for select to authenticated using (true);

drop policy if exists "signed-in insert clients" on public.listing_clients;
create policy "signed-in insert clients"
  on public.listing_clients for insert to authenticated with check (true);

drop policy if exists "signed-in update clients" on public.listing_clients;
create policy "signed-in update clients"
  on public.listing_clients for update to authenticated using (true) with check (true);

drop policy if exists "signed-in delete clients" on public.listing_clients;
create policy "signed-in delete clients"
  on public.listing_clients for delete to authenticated using (true);

drop policy if exists "signed-in read client items" on public.listing_client_items;
create policy "signed-in read client items"
  on public.listing_client_items for select to authenticated using (true);

drop policy if exists "signed-in insert client items" on public.listing_client_items;
create policy "signed-in insert client items"
  on public.listing_client_items for insert to authenticated with check (true);

drop policy if exists "signed-in update client items" on public.listing_client_items;
create policy "signed-in update client items"
  on public.listing_client_items for update to authenticated using (true) with check (true);

drop policy if exists "signed-in delete client items" on public.listing_client_items;
create policy "signed-in delete client items"
  on public.listing_client_items for delete to authenticated using (true);

-- Column layout is private to each user.
drop policy if exists "own column prefs" on public.listing_column_prefs;
create policy "own column prefs"
  on public.listing_column_prefs for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ── Automatic cleanup of closed listings ────────────────────────────
-- The crawler marks vanished listings inactive rather than deleting them, so a
-- failed scrape can never destroy data. This purges rows that have stayed
-- inactive for 90 days -- but never one an agent saved to a client, so the
-- record of what was shown survives.
create or replace function public.purge_stale_listings(retain_days int default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  removed integer;
begin
  with gone as (
    delete from public.listings l
     where l.active = false
       and l.last_seen < current_date - retain_days
       and not exists (
         select 1 from public.listing_client_items i where i.listing_id = l.id
       )
    returning 1
  )
  select count(*) into removed from gone;
  return removed;
end;
$$;

revoke all on function public.purge_stale_listings(int) from public, anon, authenticated;
