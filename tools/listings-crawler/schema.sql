-- TMG Broker Listings — run this once in the Supabase SQL Editor.

create table if not exists public.listings (
  id text primary key,                        -- stable hash of url|name|broker
  broker text not null,
  name text,
  address text,
  city text,
  submarket text,
  property_type text,                         -- office|retail|industrial|land|multifamily|mixed|other
  status text,                                -- for_lease|for_sale|both
  size text,
  price_or_rate text,
  agents jsonb default '[]'::jsonb,           -- [{name, phone, email}]
  url text,
  image_url text,
  source text,                                -- scraper key (ecr, aquila, costar, ...)
  first_seen date not null default current_date,
  last_seen date not null default current_date,
  is_new boolean not null default true,       -- new as of the most recent run
  active boolean not null default true,       -- false = disappeared from source
  raw jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists listings_active_idx on public.listings (active, broker, property_type);

create table if not exists public.crawl_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  totals jsonb,                               -- {total, new, deactivated, per_source: {...}}
  notes jsonb                                 -- per-source status/errors
);

-- Row Level Security: the portal reads with the anon key; only the service key writes.
alter table public.listings enable row level security;
alter table public.crawl_runs enable row level security;

drop policy if exists "anon can read active listings" on public.listings;
create policy "anon can read active listings"
  on public.listings for select
  to anon, authenticated
  using (active = true);

drop policy if exists "anon can read runs" on public.crawl_runs;
create policy "anon can read runs"
  on public.crawl_runs for select
  to anon, authenticated
  using (true);
