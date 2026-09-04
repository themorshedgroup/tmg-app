-- Each teammate's Zoho CRM user id, stored once.
--
-- Why: the Zoho connection has no ZohoCRM.users.READ scope, so the app can't
-- look a user up by email. The workaround was to harvest owner ids off records
-- the app CAN read (Tasks, Agent_KPIs, Contacts) and match by email/name --
-- which means your goal is attributed correctly only if you happen to own a
-- recent record in one of those three modules. Gustavo and Luciana own none,
-- so they never resolved, and Zoho silently fell back to the API connection
-- owner (Symon) -- goals and KPIs filed under the wrong person.
--
-- Storing the id removes the guess entirely.

alter table public.profiles add column if not exists zoho_user_id text;

comment on column public.profiles.zoho_user_id is
  'Zoho CRM user id for this person. Set once; used to stamp Owner on records the app creates in Zoho (health goals, agent KPIs). Null = the app cannot attribute their records and will say so rather than filing under the connection owner.';

-- Ids read live from the Owner field of records in Zoho (Health_Goals, Tasks,
-- Agent_KPIs, Contacts) on 2026-09-05. Symon's app login is manager@ while his
-- Zoho user is symon@, hence the explicit mapping rather than an email join.
update public.profiles set zoho_user_id = v.zid
from (values
  ('alexandra@themorshedgroup.com', '6597827000000899001'),
  ('brad@themorshedgroup.com',      '6597827000000750001'),
  ('brett@themorshedgroup.com',     '6597827000004255001'),
  ('gustavo@themorshedgroup.com',   '6597827000018334001'),
  ('kyle@themorshedgroup.com',      '6597827000010422001'),
  ('ea@themorshedgroup.com',        '6597827000009020001'),
  ('manager@themorshedgroup.com',   '6597827000000498001'),
  ('tarek@themorshedgroup.com',     '6597827000000744001')
) as v(email, zid)
where lower(public.profiles.email) = v.email
  and public.profiles.zoho_user_id is distinct from v.zid;
