-- Nightly call audit pull: every day at 14:00 UTC (10 PM Manila, 9 AM CT in
-- summer, 8 AM CT in winter), pg_cron calls the call-audit edge function for
-- the last 3 days of Tarek's calendar, so new transcripts and Gemini notes of
-- his calls with Operations land in public.call_audit_items without anyone
-- pressing a button. Rows upsert on (event_id, file_id), so the 3-day overlap
-- only refreshes what is already there.
--
-- The bearer is read from vault (name 'call_audit_secret', created once in
-- SQL, see 20261005090000_call_audit.sql) on every run, so no secret is in
-- the job body or in git. Safe to re-apply: the job is replaced by name.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname = 'call-audit-nightly';

select cron.schedule('call-audit-nightly', '0 14 * * *', $job$
  select net.http_post(
    url := 'https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/call-audit',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'call_audit_secret')
    ),
    body := jsonb_build_object('action', 'collect', 'since', (now() - interval '3 days')::text),
    timeout_milliseconds := 120000
  );
$job$);
