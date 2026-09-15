-- Re-granting the org's Zoho CRM authorization: keep the old key.
--
-- Adding a scope to a Zoho OAuth grant is not an edit. Zoho issues a brand new
-- refresh token for the new scope list, and the app swaps to it. If that new
-- grant turns out narrower than the old one in some way the pre-write probes
-- did not test, EVERY Zoho feature in the app breaks at once for everybody --
-- the Calls tab, the KPI writes, the CRM skin, the task sync.
--
-- Zoho does not revoke a refresh token just because another one was issued to
-- the same client. So the old one keeps working, and keeping a copy of it turns
-- a company-wide outage into one UPDATE:
--
--   update public.zoho_connection
--      set refresh_token = previous_refresh_token,
--          access_token = null, access_token_expires_at = null;
--
-- Only ever holds the token the app itself replaced, one deep. It is not a
-- history: the next reconnect overwrites it.
alter table public.zoho_connection
  add column if not exists previous_refresh_token text,
  add column if not exists reconnected_at timestamptz;

comment on column public.zoho_connection.previous_refresh_token is
  'The refresh token this row held before the last reconnect. Kept ONLY so a bad re-grant can be rolled back in one UPDATE -- Zoho leaves superseded refresh tokens valid. Never read by the app.';
comment on column public.zoho_connection.reconnected_at is
  'When the refresh token was last replaced by the admin reconnect flow.';

-- The table is service-role only (the edge function holds the secrets and no
-- browser ever selects from it), so there are no policies to widen here. State
-- that explicitly rather than leaving the next reader to check.
alter table public.zoho_connection enable row level security;
