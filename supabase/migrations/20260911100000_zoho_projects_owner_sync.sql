-- Zoho Projects owner sync (Bug B fix): person_responsible needs a Zoho
-- Projects PORTAL user id, which is a different id space from profiles.
-- zoho_user_id (that column is Zoho CRM's org, confirmed a different
-- numeric namespace). Resolving email -> portal user id needs a real Zoho
-- API call (GET /users/), so the result is cached here rather than called
-- on every single task sync — Zoho Projects' rate limit is a tight 100
-- calls/2 min per token.
alter table public.zoho_projects_connection
  add column if not exists portal_users_cache jsonb,
  add column if not exists portal_users_cached_at timestamptz;
