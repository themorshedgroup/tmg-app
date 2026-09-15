-- Everyone means everyone, including whoever starts next month.
--
-- 20260910180000 seeded brief_mailboxes ON for every profile that was active
-- THAT DAY, and the column defaults to false. So anybody onboarded since has
-- no row at all, and cbSearchMailbox reads a missing row as "not_enabled" —
-- the sheet then tells the agent their own mailbox is "switched off for
-- summaries" when nobody ever switched it off. Their brief is quietly worse
-- than everyone else's and nothing says why.
--
-- Same policy as the original seed, applied on an ongoing basis: an active
-- profile gets a row, ON. `on conflict do nothing` means a deliberate opt-out
-- is never re-enabled by this, including for somebody switched off and later
-- reactivated.

-- Catch anyone added between 2026-09-10 and today.
insert into public.brief_mailboxes (user_id, enabled)
select id, true from public.profiles where status = 'active'
on conflict (user_id) do nothing;

-- And keep it true from here on.
create or replace function public.brief_mailboxes_seed_active()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'active' then
    insert into public.brief_mailboxes (user_id, enabled)
    values (new.id, true)
    on conflict (user_id) do nothing;
  end if;
  return new;
end;
$$;

comment on function public.brief_mailboxes_seed_active is
  'Gives every newly active profile a brief_mailboxes row set ON, matching the one-time seed in 20260910180000. Never re-enables a row somebody turned off.';

drop trigger if exists brief_mailboxes_seed_active_ins on public.profiles;
create trigger brief_mailboxes_seed_active_ins
  after insert on public.profiles
  for each row execute function public.brief_mailboxes_seed_active();

drop trigger if exists brief_mailboxes_seed_active_upd on public.profiles;
create trigger brief_mailboxes_seed_active_upd
  after update of status on public.profiles
  for each row when (new.status = 'active' and old.status is distinct from 'active')
  execute function public.brief_mailboxes_seed_active();
