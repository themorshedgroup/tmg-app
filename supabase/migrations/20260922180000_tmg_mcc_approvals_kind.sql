-- Commercial charts are quarterly and file to a different set of Drive folders,
-- so the placement step has to know which pipeline an approved row belongs to.
-- month holds 'YYYY-MM' for residential and 'YYYY-QN' for commercial, which keeps
-- the one-pending-row-per-month unique index correct across both.
alter table public.tmg_mcc_approvals
  add column if not exists kind text not null default 'residential'
    check (kind in ('residential', 'commercial'));
