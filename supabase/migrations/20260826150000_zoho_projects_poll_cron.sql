-- Documents (does not itself re-provision) the pg_cron job that polls
-- zoho-projects-poll every 5 minutes. Extensions are safe to re-apply; the
-- vault secret + cron.schedule() call were run once via a one-off
-- `supabase db query --linked -f <scratch file>` (not committed — it held
-- the raw secret) rather than as a versioned migration, so the secret value
-- never lands in git history. Live job: jobname 'zoho-projects-poll',
-- schedule '*/5 * * * *', calls net.http_post() against
-- .../functions/v1/zoho-projects-poll with an Authorization header pulled
-- live from vault.decrypted_secrets (name 'zoho_poll_cron_secret') on every
-- run, so the secret is stored once in Vault, never inlined in the job body.
--
-- To redo this setup from scratch (e.g. new environment, secret rotation):
--   1. Generate a new random value; `supabase secrets set
--      ZOHO_POLL_CRON_SECRET=<value>` (edge function secret) and redeploy
--      zoho-projects-poll.
--   2. Via `supabase db query --linked -f <scratch file>` (not a migration),
--      run:
--        delete from vault.secrets where name = 'zoho_poll_cron_secret';
--        select vault.create_secret('<same value>', 'zoho_poll_cron_secret', '...');
--        select cron.unschedule(jobid) from cron.job where jobname = 'zoho-projects-poll';
--        select cron.schedule('zoho-projects-poll', '*/5 * * * *', $c$
--          select net.http_post(
--            url := 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/zoho-projects-poll',
--            headers := jsonb_build_object('Content-Type','application/json',
--              'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'zoho_poll_cron_secret')),
--            body := '{}'::jsonb
--          );
--        $c$);
--
-- See plan hidden-wiggling-lamport §4 and the rate-limit comment at the
-- bottom of supabase/functions/zoho-projects-poll/index.ts for the interval
-- reasoning (5 min is safe — the rate limit is a per-run burst ceiling on
-- linked-project count, not a function of cron frequency).

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;
