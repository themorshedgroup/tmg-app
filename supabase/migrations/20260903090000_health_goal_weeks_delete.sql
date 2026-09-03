-- Clearing a week back to blank deletes its row: "not marked yet" is the
-- absence of a row, which is what keeps it distinct from "marked as missed"
-- (done = false). Without a delete policy RLS silently removes nothing and
-- the mark springs back on reload.

drop policy if exists "signed-in delete health goal weeks" on public.health_goal_weeks;
create policy "signed-in delete health goal weeks"
  on public.health_goal_weeks for delete to authenticated using (true);
