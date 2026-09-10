-- Tighten tmg_meeting_notices / tmg_task_digests from "any admin" to Symon
-- specifically, matching the new Email Notifications tab (src/index.jsx,
-- isSymon) which is deliberately narrower than isAdmin — this is Symon's own
-- notification history, not a general admin surface. Without this, another
-- admin could still read the rows directly (RLS, not just UI) even though
-- the tab is hidden from them.

drop policy if exists "tmg_meeting_notices_select_admin" on public.tmg_meeting_notices;
create policy "tmg_meeting_notices_select_symon" on public.tmg_meeting_notices
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
       and lower(p.email) in ('symon@themorshedgroup.com', 'manager@themorshedgroup.com')
  ));

drop policy if exists "tmg_task_digests_select_admin" on public.tmg_task_digests;
create policy "tmg_task_digests_select_symon" on public.tmg_task_digests
  for select to authenticated
  using (exists (
    select 1 from public.profiles p
     where p.id = auth.uid() and p.status = 'active'
       and lower(p.email) in ('symon@themorshedgroup.com', 'manager@themorshedgroup.com')
  ));
