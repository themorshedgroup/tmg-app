-- August 2026 weekly ticks, as tracked off-app before the Health Goals tab
-- existed. Keyed by the Zoho Health_Goals record id (see the table's own
-- migration for why the ticks live here and not in Zoho).
--
-- August 2026 has four Monday-start weeks by the rule the tab uses -- a week
-- belongs to the month holding its Thursday -- so weeks 1-4 are Aug 3, 10, 17
-- and 24. Brad logged no August goal, so he has no record and no ticks.

insert into public.health_goal_weeks (zoho_id, week, done) values
  -- Tarek Morshed -- 4 workouts + 2 cheat meals/sweets a week (3/4)
  ('6597827000019651001', 1, false),
  ('6597827000019651001', 2, true),
  ('6597827000019651001', 3, true),
  ('6597827000019651001', 4, true),
  -- Brett Silverman -- 10k steps/day, no snacks after 8pm, 300 pushups/week (1/4)
  ('6597827000019630002', 1, false),
  ('6597827000019630002', 2, false),
  ('6597827000019630002', 3, false),
  ('6597827000019630002', 4, true),
  -- Kyle Baird -- 5 workouts/week (3/4)
  ('6597827000019652001', 1, false),
  ('6597827000019652001', 2, true),
  ('6597827000019652001', 3, true),
  ('6597827000019652001', 4, true),
  -- Symon Yongco -- 1 workout + 7 hrs sleep/day (2/4)
  ('6597827000019566021', 1, false),
  ('6597827000019566021', 2, true),
  ('6597827000019566021', 3, false),
  ('6597827000019566021', 4, true),
  -- Luciana Pilco -- 2 walks + 1 swim/week (3/4)
  ('6597827000019581001', 1, false),
  ('6597827000019581001', 2, true),
  ('6597827000019581001', 3, true),
  ('6597827000019581001', 4, true),
  -- Alexandra Machado -- 3 workouts + 8 hrs sleep/day (3/4)
  ('6597827000019650001', 1, false),
  ('6597827000019650001', 2, true),
  ('6597827000019650001', 3, true),
  ('6597827000019650001', 4, true),
  -- Gustavo Hernandez -- 3 workouts/week (3/4)
  ('6597827000019827001', 1, false),
  ('6597827000019827001', 2, true),
  ('6597827000019827001', 3, true),
  ('6597827000019827001', 4, true)
on conflict (zoho_id, week) do update
  set done = excluded.done, updated_at = now();
