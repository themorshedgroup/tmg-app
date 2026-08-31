-- Each client folder is owned by an agent, chosen from the staff directory
-- when the client is created. Nullable so existing rows stay valid.
alter table public.listing_clients
  add column if not exists agent_id uuid references public.profiles (id) on delete set null;

create index if not exists listing_clients_agent_idx on public.listing_clients (agent_id);
