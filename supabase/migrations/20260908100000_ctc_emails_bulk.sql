-- Newsletters and marketing blasts were most of what a real mailbox returned
-- on first pull. Filtering them is worth doing WITHOUT AI: the model is the
-- only part of this feature that costs money, so bulk mail must be identified
-- deterministically and then kept away from triage entirely.
--
-- Three layers, all free:
--   1. Gmail query excludes the promotions/social/forums categories, so most
--      of it is never even fetched (see BASE_QUERY in the ctc-emails function).
--   2. Anything that still lands in Primary is flagged here at ingest from
--      headers we already request: List-Unsubscribe / List-Id / Precedence are
--      what bulk senders are required to set, so this is a definition, not a
--      guess. No body, no model, no tokens.
--   3. The Emails tab hides flagged mail by default and triage skips it.
--
-- Flagged rather than dropped on purpose: a false positive stays recoverable
-- (the Newsletters filter in the tab), and rows are cheap — tokens are not.
alter table public.ctc_emails add column if not exists is_bulk boolean not null default false;
-- Why it was flagged, so a wrong call can be diagnosed instead of argued about.
alter table public.ctc_emails add column if not exists bulk_reason text;

-- The tab's default read is "not bulk, needs filing", so index that shape.
create index if not exists ctc_emails_not_bulk_idx
  on public.ctc_emails (email_date desc) where is_bulk = false;
