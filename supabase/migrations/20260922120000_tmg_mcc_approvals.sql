-- Market Comparison Chart approvals.
-- One row per month's MCC sent for approval. The mcc-approval edge function
-- writes every row with the service role; the emailed Approve/Reject link is
-- authorised by the row's own random token, not by a login.
create table if not exists public.tmg_mcc_approvals (
  id               uuid primary key default gen_random_uuid(),
  month            text not null,                       -- chart month, 'YYYY-MM'
  basis            text not null default 'austin_title',-- 'austin_title' | 'unlock_fallback'
  status           text not null default 'pending'
                     check (status in ('pending','approved','rejected')),
  token            text not null unique,                -- secret in the emailed link
  summary          jsonb not null default '{}'::jsonb,  -- facts shown in the email
  buyer_filename   text,
  seller_filename  text,
  sent_to          text[],
  gmail_message_id text,
  created_at       timestamptz not null default now(),
  decided_at       timestamptz,
  placed_at        timestamptz                          -- set once the Mac files it
);

-- At most one pending request per month, so a retrying cron cannot spam the inbox.
create unique index if not exists tmg_mcc_approvals_one_pending_per_month
  on public.tmg_mcc_approvals (month) where status = 'pending';
create index if not exists tmg_mcc_approvals_month_idx
  on public.tmg_mcc_approvals (month);

-- Service role only: RLS on with no policies means anon and authenticated get nothing.
alter table public.tmg_mcc_approvals enable row level security;
revoke all on public.tmg_mcc_approvals from anon, authenticated;
