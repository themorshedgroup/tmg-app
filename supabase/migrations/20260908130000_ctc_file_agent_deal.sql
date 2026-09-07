-- CTC file ↔ Zoho Deal linkage, plus the Agent behind a file.
--
-- Symon's convention in Zoho Projects is a title of
--   "<address> (<agent>-<deal type>)"
-- and the matching Zoho CRM Deal carries the same address inside its name
-- ("<client names> <address>"). So a CTC file needs three things it lacks
-- today: which agent it belongs to, which deal it is, and the deal type.
--
-- Deal type deliberately REUSES group_tag: that column is already what the
-- CTC surface calls "Side" (free text: Buyer/Seller/Landlord) and is already
-- rendered on every card, list row and the Overview. Relabelling it "Deal
-- Type" and feeding it from Zoho's own picklist is a UI change, not a schema
-- one — and keeps existing rows valid.
alter table public.projects add column if not exists agent_id uuid references public.profiles(id) on delete set null;
alter table public.projects add column if not exists zoho_deal_id text;
alter table public.projects add column if not exists zoho_deal_name text;

create index if not exists projects_agent_idx on public.projects (agent_id) where agent_id is not null;
create index if not exists projects_zoho_deal_idx on public.projects (zoho_deal_id) where zoho_deal_id is not null;
