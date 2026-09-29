// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: google-tasks-sync
//
// Keeps each person's Google Tasks and their TMG My Tasks in step, both ways.
//
//   OUT  every TMG task ASSIGNED to someone appears in that person's Google
//        Tasks, so an agent sees their work on their phone without opening
//        the app. A task with nobody on it is left alone.
//
//        What gets sent, first match wins:
//          1. the task's own switch      tasks.google_tasks_sync
//          2. its project's switch       projects.google_tasks_sync
//          3. neither set: send, except a CTC file's tasks to a Transaction
//             Coordinator (profiles.access includes 'tc'). A TC owns nearly
//             every checklist item on every file in Zoho, so without this
//             their phone gets the whole pool.
//        When a task stops qualifying, the copy made here is deleted from
//        that person's Google Tasks. An agenda item is never deleted: it is
//        the Doc's own task, and deleting it would unassign it in the Doc.
//   IN   a checklist item assigned to someone inside one of the meeting
//        agendas is ALREADY a real Google Task; Google Docs makes it. We read
//        those back and file them under that person's My Tasks.
//
// Nothing here reads a document and no AI is involved. An agenda task is
// recognised only by the Drive file id Google stamps on it
// (Task.assignmentInfo.driveResourceInfo.driveFileId). A Google task with no
// matching id in `agenda_docs` — i.e. everything personal — is skipped and
// never stored.
//
// Because Docs and Tasks are themselves two-way, ticking an agenda task off
// in the app ticks the checkbox in the meeting agenda.
//
// Deploy: `supabase functions deploy google-tasks-sync --no-verify-jwt`.
//   Verify JWT must be OFF: the cron has no user session and authenticates
//   with GTASKS_CRON_SECRET. A signed-in person is still authenticated —
//   their JWT is validated below — so "Sync now" works from the app.
//
// Secrets:
//   GTASKS_CRON_SECRET   long random string; only this function and its
//                        pg_cron job know it. Deliberately its own secret,
//                        not shared with sffu-sender or zoho-projects-poll.
//   GOOGLE_CLIENT_SECRET same OAuth client as google-calendar.
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// Actions:
//   { action: 'run' }              cron or an admin — sync everyone connected
//   { action: 'run_me' }           a signed-in person — sync just themselves
//   { action: 'status' }           a signed-in person — their own sync state
//
// Cost: Google's Tasks API is free with a 50,000 call/day allowance. Ten
// people polled every 15 minutes is a few thousand calls a day, well inside
// it — see the CAPS block below for the per-run ceilings.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ── CAPS ──
// Deliberate ceilings so one runaway account can't spend the whole daily
// allowance. Anything dropped is reported in the response and stored on the
// person's sync row — a silent cap reads as "everything is in sync" when it
// isn't.
const MAX_PAGES_PER_LIST = 10;    // 100 tasks a page
const MAX_PUSH_PER_RUN   = 200;
// Deleting copies back out of Google when a task stops qualifying. The first
// run after the TC rule landed has ~765 to take back from one person, so this
// drains over a few runs instead of spending one run's whole budget on it.
const MAX_REMOVE_PER_RUN = 200;
const MAX_PULL_PER_RUN   = 200;
// Everyone is synced one after another in a single request, and the platform
// stops a request at 150s. Past this point in a run, no more Google writes
// start; whatever is left comes through on the next pass, 15 minutes later.
const WRITE_BUDGET_MS    = 95_000;
let writeDeadline = Infinity;
const outOfTime = () => Date.now() > writeDeadline;
// How far back a finished task is still worth pushing. Without this, turning
// the sync on would dump years of completed work into someone's phone.
const DONE_LOOKBACK_DAYS = 30;
// How far back an OPEN agenda item is still worth pulling in. These documents
// go back to 2022 and carry years of unticked lines from people who have left;
// without this, switching the sync on buries everyone.
const IMPORT_LOOKBACK_DAYS = 120;
// Re-scan window on each poll: Google's updatedMin is exclusive-ish and clock
// skew is real, so we always look a little further back than last time.
const CURSOR_OVERLAP_MIN = 10;

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

async function googleAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    // Same public OAuth client as google-calendar; the `.../auth/tasks` scope
    // is already granted at Connect, so nobody has to reconnect for this.
    client_id: "931478099859-9jifv0fl9v3s67oc7pa5ka6j61eeujfq.apps.googleusercontent.com",
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to refresh Google token");
  }
  return data.access_token as string;
}

const TASKS_API = "https://www.googleapis.com/tasks/v1";
async function gfetch(token: string, path: string, init?: RequestInit) {
  const res = await fetch(TASKS_API + path, {
    ...init,
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`${init?.method || "GET"} ${path} → ${res.status} ${data?.error?.message || text.slice(0, 200)}`);
  return data;
}

// ── Field mapping ─────────────────────────────────────────────────────────
// Google Tasks stores a DATE, not a moment — the time part is ignored on the
// way in and meaningless on the way out. Both conversions use UTC midnight so
// a task due "Sep 15" never lands on the 14th for someone in Manila.
const toGoogleDue = (dueAt: string | null) => dueAt ? new Date(dueAt).toISOString().slice(0, 10) + "T00:00:00.000Z" : null;
const fromGoogleDue = (due: string | null | undefined) => due ? due.slice(0, 10) + "T00:00:00.000Z" : null;
// Google has two states and TMG has eight (Zoho's). Completed and Cancelled
// are both closed, so both show ticked; the other six are all "not ticked".
const isClosed = (s: string | null | undefined) => s === "done" || s === "cancelled";
const toGoogleStatus = (s: string) => (isClosed(s) ? "completed" : "needsAction");
const fromGoogleStatus = (s: string) => (s === "completed" ? "done" : "todo");

type SyncResult = { user_id: string; pushed: number; pulled: number; updated: number; removed: number; skipped?: string; error?: string; sample?: string[]; agenda?: { importable: number; already_done: number; stale: number } };

// Whether a task belongs in this person's Google Tasks; see the header for
// the order. Only a real boolean counts as a setting; null falls through to
// the next rule. (The reads below name the column, so the migration that adds
// it must be applied before this is deployed.)
function wantsGoogle(t: any, proj: any, isTc: boolean): boolean {
  if (typeof t.google_tasks_sync === "boolean") return t.google_tasks_sync;
  if (proj && typeof proj.google_tasks_sync === "boolean") return proj.google_tasks_sync;
  return !(isTc && proj?.record_type === "ctc_file");
}

// `dry` reads both sides and reports exactly what a real run would do, without
// writing a single row here or in anybody's Google account. It exists because
// the first live run touches real teammates' phones, and "look before you
// write" is cheap when the read is the same code path.
// Every row, a page at a time. PostgREST stops a plain read at 1000 rows
// without saying so, and a Transaction Coordinator is assignee on ~1,900
// tasks. Null on any failed page, so a short read is never mistaken for the
// whole list. `q` must build a fresh, ordered query each call.
async function readAll(q: () => any): Promise<any[] | null> {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q().range(from, from + 999);
    if (error) return null;
    rows.push(...(data || []));
    if (!data || data.length < 1000) return rows;
  }
}

async function syncUser(sb: any, userId: string, agendaByFile: Map<string, any>, dry = false): Promise<SyncResult> {
  const out: SyncResult = { user_id: userId, pushed: 0, pulled: 0, updated: 0, removed: 0 };
  const sample: string[] = [];
  // Dry-run only: how the agenda backlog splits, so the size of a first
  // import is a known number rather than a surprise.
  let seenOpen = 0, seenDone = 0, seenStale = 0;

  const { data: tok } = await sb.from("google_tokens").select("refresh_token").eq("user_id", userId).maybeSingle();
  if (!tok?.refresh_token) { out.skipped = "not_connected"; return out; }

  // Respect the per-person off switch. Absent prefs mean on: the sync is
  // meant to just work, and only someone who has deliberately turned it off
  // should be skipped.
  const { data: prof } = await sb.from("profiles").select("calendar_prefs,status,access").eq("id", userId).maybeSingle();
  if (!prof || prof.status !== "active") { out.skipped = "inactive"; return out; }
  if (prof.calendar_prefs && prof.calendar_prefs.autoSyncTasks === false) { out.skipped = "opted_out"; return out; }
  const isTc = Array.isArray(prof.access) && prof.access.includes("tc");

  let token: string;
  try { token = await googleAccessToken(tok.refresh_token); }
  catch (e) { out.error = "needs_reconnect: " + String((e as any)?.message || e); return out; }

  const { data: stateRow } = await sb.from("google_tasks_sync_state").select("*").eq("user_id", userId).maybeSingle();
  const cursor: string | null = stateRow?.cursor_at || null;
  const runStartedAt = new Date();

  // Every link this person already has, indexed both ways.
  const linkRows = await readAll(() => sb.from("google_task_links").select("*").eq("user_id", userId).order("task_id"));
  // Without every link, a linked task reads as new and is pushed again.
  if (!linkRows) {
    out.error = "link read failed";
    // Say so on the status panel; the cursor stays where it was.
    if (!dry) await sb.from("google_tasks_sync_state").upsert({ user_id: userId, last_run_at: new Date().toISOString(), last_error: out.error }, { onConflict: "user_id" });
    return out;
  }
  const byGoogleId = new Map<string, any>();
  const byTaskId = new Map<string, any>();
  for (const l of (linkRows || [])) { byGoogleId.set(l.google_task_id, l); byTaskId.set(l.task_id, l); }

  let truncated = false;

  // ── IN: read Google, import agenda tasks, pull completions back ─────────
  const lists = await gfetch(token, "/users/@me/lists?maxResults=100");
  for (const list of (lists.items || [])) {
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_LIST; page++) {
      const qs = new URLSearchParams({
        maxResults: "100",
        // Assigned tasks — the ones Docs creates — are NOT returned unless
        // this is set. Without it the agenda half of this simply finds nothing.
        showAssigned: "true",
        showCompleted: "true",
        showHidden: "true",
      });
      if (cursor) qs.set("updatedMin", cursor);
      if (pageToken) qs.set("pageToken", pageToken);
      const res = await gfetch(token, `/lists/${encodeURIComponent(list.id)}/tasks?` + qs.toString());

      for (const gt of (res.items || [])) {
        if (gt.deleted) continue;
        const link = byGoogleId.get(gt.id);
        const driveId = gt.assignmentInfo?.driveResourceInfo?.driveFileId || null;

        if (link) {
          // Known task. Google is only allowed to move the status — title and
          // date belong to whichever side owns the task, and letting both
          // sides rewrite both fields is how sync loops start.
          const { data: t } = await sb.from("tasks").select("id,status,updated_at").eq("id", link.task_id).maybeSingle();
          if (!t) continue;
          const googleUpdated = gt.updated ? new Date(gt.updated) : null;
          const tmgUpdated = t.updated_at ? new Date(t.updated_at) : null;
          const googleIsNewer = googleUpdated && (!tmgUpdated || googleUpdated > tmgUpdated);
          // Google can only say ticked or not, so it may only move a task
          // across that line, and only when the checkbox itself moved since
          // this job last wrote it. Reading "not ticked" as To Do reset In
          // Progress, Completed and the rest to To Do right after every push
          // (22 Accountabilities tasks on 2026-09-28): the push itself makes
          // Google's copy the newer one, and a Zoho pull never moves
          // updated_at, so Google won every time. Unticked on a task that is
          // open in any of TMG's six ways leaves that status alone.
          const googleMoved = (link.last_pushed?.status ?? null) !== gt.status;
          const gClosed = gt.status === "completed";
          const want = gClosed ? "done" : "todo";
          const crosses = gClosed !== isClosed(t.status);
          if (googleMoved && crosses && googleIsNewer) {
            if (sample.length < 8) sample.push(`status ${t.status}→${want}: ${gt.title || ""}`);
            if (!dry) {
              const patch: any = { status: want, updated_at: new Date().toISOString() };
              if (want === "done") patch.completed_at = gt.completed || new Date().toISOString();
              else patch.completed_at = null;
              await sb.from("tasks").update(patch).eq("id", t.id);
              // field "status" also tells the Zoho sync this status is TMG's
              // own change, so a later conflict with Zoho sends it there.
              await sb.from("task_activity").insert({ task_id: t.id, kind: "system", field: "status",
                content: gClosed ? "Status: marked Completed in Google Tasks." : "Status: reopened (To Do) in Google Tasks." });
            }
            out.updated++;
          }
          if (!dry) {
            const linkPatch: any = { google_updated: gt.updated || null, synced_at: new Date().toISOString() };
            // A checkbox move, once read, counts as seen. Only a push used to
            // record it, so when no push followed, the person's NEXT tick was
            // compared against an old state and ignored. When the app won
            // instead (its edit is newer), recording it is what makes the OUT
            // pass below see a difference and put the app's state back on the
            // phone. Same object as byTaskId's, so the OUT pass sees it.
            if (googleMoved) {
              linkPatch.last_pushed = { ...(link.last_pushed || {}), status: gt.status };
              link.last_pushed = linkPatch.last_pushed;
            }
            await sb.from("google_task_links").update(linkPatch)
              .eq("task_id", link.task_id).eq("user_id", userId);
          }
          continue;
        }

        // Unknown to us. Import ONLY if it came from one of the agendas —
        // everything else in this list is the person's own business.
        if (!driveId) continue;
        const doc = agendaByFile.get(driveId);
        if (!doc) continue;
        // A checkbox that was already ticked is history — importing years of
        // finished agenda items would bury everyone's real list. Completion
        // still flows for anything we DO import, from then on.
        if (gt.status === "completed") { if (dry) seenDone++; continue; }
        // Same for items nobody has touched in a long time: they were dropped,
        // not done, and dragging them into My Tasks helps no one.
        const touched = gt.updated ? new Date(gt.updated).getTime() : 0;
        if (touched && touched < Date.now() - IMPORT_LOOKBACK_DAYS * 86400000) { if (dry) seenStale++; continue; }
        if (out.pulled >= MAX_PULL_PER_RUN) { truncated = true; continue; }
        if (dry) seenOpen++;
        if (sample.length < 8) sample.push(`import from ${doc.name}: ${gt.title || ""}`);
        if (dry) { out.pulled++; continue; }

        const { data: made, error: mkErr } = await sb.from("tasks").insert({
          title: gt.title || "(untitled)",
          due_at: fromGoogleDue(gt.due),
          status: fromGoogleStatus(gt.status),
          priority: "medium",
          // Provenance without inventing a project: the agenda's name shows on
          // the task, and Working URL opens the document it came from.
          context: doc.name || "Meeting agenda",
          // The project the agenda's to-dos belong to (agenda_docs.project_id,
          // added 20260924120000). This is what carries them to Zoho: the
          // poller only pushes tasks in a project with zoho_sync_enabled, so
          // before this every imported to-do was stranded in the app. Null is
          // still allowed: an agenda with no project set behaves as before.
          project_id: doc.project_id || null,
          working_url: doc.url || null,
          created_by: userId,
          completed_at: gt.status === "completed" ? (gt.completed || new Date().toISOString()) : null,
        }).select().single();
        if (mkErr || !made) continue;
        await sb.from("task_people").insert({ task_id: made.id, user_id: userId, role: "assignee" });
        await sb.from("google_task_links").insert({
          task_id: made.id, user_id: userId, google_task_id: gt.id, google_list_id: list.id,
          origin: "pull", drive_file_id: driveId, google_updated: gt.updated || null,
          last_pushed: { title: gt.title || "", status: gt.status, due: gt.due || null },
        });
        byGoogleId.set(gt.id, { task_id: made.id, user_id: userId, google_task_id: gt.id, origin: "pull" });
        byTaskId.set(made.id, { google_task_id: gt.id, google_list_id: list.id, origin: "pull" });
        out.pulled++;
      }

      pageToken = res.nextPageToken;
      if (!pageToken) break;
      if (page === MAX_PAGES_PER_LIST - 1) truncated = true;
    }
  }

  // ── OUT: every TMG task assigned to this person ────────────────────────
  const mine = await readAll(() => sb.from("task_people").select("task_id").eq("user_id", userId).eq("role", "assignee").order("task_id"));
  if (!mine) { out.error = "assignee read failed"; truncated = true; }
  const myIds = [...new Set((mine || []).map((r: any) => r.task_id))];

  // Take a copy made here back out of this person's Google Tasks. Attempts
  // count against the cap, not just successes, so a run that Google is
  // throttling stops trying instead of burning through the whole backlog.
  let removeTries = 0;
  const removeCopy = async (t: any, link: any) => {
    if (removeTries >= MAX_REMOVE_PER_RUN || outOfTime()) { truncated = true; return; }
    removeTries++;
    if (sample.length < 8) sample.push(`remove: ${t.title}`);
    if (dry) { out.removed++; return; }
    // The IN pass above already ran, so a tick made on the phone since the
    // last run is in the app before its copy goes.
    try {
      await gfetch(token, `/lists/${encodeURIComponent(link.google_list_id)}/tasks/${encodeURIComponent(link.google_task_id)}`,
        { method: "DELETE" });
    } catch (e) {
      const msg = String((e as any)?.message || e);
      // Already gone from Google (the person deleted it): only the link is left to clear.
      if (!/→ (404|410)\b/.test(msg)) { out.error = msg; return; }
    }
    const { error: unlinkErr } = await sb.from("google_task_links").delete().eq("task_id", t.id).eq("user_id", userId);
    // The copy is gone either way; a link left behind is retried next run and
    // then clears on Google's 404.
    if (unlinkErr) { out.error = "unlink: " + unlinkErr.message; return; }
    byTaskId.delete(t.id);
    byGoogleId.delete(link.google_task_id);
    out.removed++;
  };
  const cutoff = new Date(Date.now() - DONE_LOOKBACK_DAYS * 86400000).toISOString();
  const projById = new Map<string, any>();
  for (let i = 0; i < myIds.length; i += 150) {
    const { data: batch, error: batchErr } = await sb.from("tasks")
      .select("id,title,status,due_at,updated_at,completed_at,project_id,google_tasks_sync")
      .in("id", myIds.slice(i, i + 150));
    // A failed read must never look like an empty or a switched-off batch:
    // the first would silently stop pushes, the second would delete copies.
    if (batchErr) { out.error = "task read: " + batchErr.message; truncated = true; continue; }
    const needProj = [...new Set((batch || []).map((t: any) => t.project_id).filter((id: any) => id && !projById.has(id)))];
    if (needProj.length) {
      const { data: projs, error: projErr } = await sb.from("projects").select("id,record_type,google_tasks_sync").in("id", needProj);
      // Same reason, sharper: without the project a CTC task reads as an
      // ordinary one and would be sent straight back to the TC.
      if (projErr) { out.error = "project read: " + projErr.message; truncated = true; continue; }
      for (const pr of (projs || [])) projById.set(pr.id, pr);
    }
    for (const t of (batch || [])) {
      const link = byTaskId.get(t.id);
      // The switches govern what this sync SENDS. An agenda item came in from
      // a Doc and is already a Google Task, so it keeps syncing its status
      // whatever its project says.
      const fromAgenda = !!link && link.origin === "pull";
      if (!fromAgenda && !wantsGoogle(t, t.project_id ? projById.get(t.project_id) : null, isTc)) {
        if (link) await removeCopy(t, link);
        continue;
      }
      // Old finished work stays out of it, see DONE_LOOKBACK_DAYS.
      // Only for tasks with no copy yet: a copy already on the phone is still
      // ticked off, however long ago (or undated) the completion was.
      if (t.status === "done" && !link && (!t.completed_at || t.completed_at < cutoff)) continue;
      // Cancelled work is never sent out. A copy already on someone's phone
      // is ticked off once below, so it stops reading as live work there.
      if (t.status === "cancelled" && !link) continue;
      const payload = { title: t.title, status: toGoogleStatus(t.status), due: toGoogleDue(t.due_at) };

      if (!link) {
        if (out.pushed >= MAX_PUSH_PER_RUN || outOfTime()) { truncated = true; continue; }
        if (sample.length < 8) sample.push(`push new: ${t.title}`);
        if (dry) { out.pushed++; continue; }
        try {
          const body: any = { title: payload.title, status: payload.status };
          if (payload.due) body.due = payload.due;
          if (payload.status === "completed") body.completed = t.completed_at || new Date().toISOString();
          const made = await gfetch(token, "/lists/@default/tasks", { method: "POST", body: JSON.stringify(body) });
          await sb.from("google_task_links").insert({
            task_id: t.id, user_id: userId, google_task_id: made.id, google_list_id: "@default",
            origin: "push", google_updated: made.updated || null, last_pushed: payload,
          });
          out.pushed++;
        } catch (e) { out.error = String((e as any)?.message || e); }
        continue;
      }

      // Already linked — write only when something actually differs, so a
      // quiet week costs one list call and no writes at all.
      const prev = link.last_pushed || {};
      const sameTitle = prev.title === payload.title;
      const sameDue = (prev.due || null) === (payload.due || null);
      const sameStatus = prev.status === payload.status;
      if (sameTitle && sameDue && sameStatus) continue;
      if (sample.length < 8) sample.push(`push change: ${t.title}`);
      if (dry) { out.updated++; continue; }
      try {
        // An agenda task's title and date belong to the document, so only its
        // status is ever written back — that is what ticks the checkbox.
        const body: any = { status: payload.status };
        if (link.origin !== "pull") { body.title = payload.title; body.due = payload.due; }
        if (payload.status === "completed") body.completed = t.completed_at || new Date().toISOString();
        const res = await gfetch(token, `/lists/${encodeURIComponent(link.google_list_id)}/tasks/${encodeURIComponent(link.google_task_id)}`,
          { method: "PATCH", body: JSON.stringify(body) });
        await sb.from("google_task_links").update({
          last_pushed: payload, google_updated: res.updated || null, synced_at: new Date().toISOString(),
        }).eq("task_id", t.id).eq("user_id", userId);
        out.updated++;
      } catch (e) {
        const msg = String((e as any)?.message || e);
        // The person deleted this copy in Google. Recorded as sent so it is not
        // retried, and failing, on every run. The link stays: without it the
        // next run would post a fresh copy of something they chose to delete.
        if (/→ (404|410)\b/.test(msg)) {
          await sb.from("google_task_links").update({ last_pushed: payload, synced_at: new Date().toISOString() })
            .eq("task_id", t.id).eq("user_id", userId);
          continue;
        }
        // Google restricts edits on tasks that came from a Doc. If it refuses,
        // the app's own status stays the truth and the reason is recorded
        // rather than swallowed.
        out.error = msg;
      }
    }
  }

  // Copies made here for tasks no longer assigned to this person (Zoho moved
  // the owner, say) never pass through the loop above. Judge them by the same
  // rule, from the task and project themselves: being missing from the list
  // is never a reason to delete on its own. Skipped when the list read failed.
  if (mine) {
    const assigned = new Set(myIds);
    const strays = [...byTaskId.entries()].filter(([id, l]) => l.origin === "push" && !assigned.has(id)).map(([id]) => id);
    let i = 0;
    for (; i < strays.length && removeTries < MAX_REMOVE_PER_RUN && !outOfTime(); i += 150) {
      const { data: batch, error: batchErr } = await sb.from("tasks")
        .select("id,title,project_id,google_tasks_sync").in("id", strays.slice(i, i + 150));
      if (batchErr) { out.error = "task read: " + batchErr.message; truncated = true; continue; }
      const needProj = [...new Set((batch || []).map((t: any) => t.project_id).filter((id: any) => id && !projById.has(id)))];
      if (needProj.length) {
        const { data: projs, error: projErr } = await sb.from("projects").select("id,record_type,google_tasks_sync").in("id", needProj);
        if (projErr) { out.error = "project read: " + projErr.message; truncated = true; continue; }
        for (const pr of (projs || [])) projById.set(pr.id, pr);
      }
      for (const t of (batch || [])) {
        const link = byTaskId.get(t.id);
        if (link && link.origin === "push" && !wantsGoogle(t, t.project_id ? projById.get(t.project_id) : null, isTc)) await removeCopy(t, link);
      }
    }
    // Stopping at the cap or the clock leaves copies behind: a short run.
    if (i < strays.length) truncated = true;
  }

  if (sample.length) out.sample = sample;
  if (dry) {
    out.agenda = { importable: seenOpen, already_done: seenDone, stale: seenStale };
    if (truncated) out.skipped = "truncated";
    return out;
  }

  const nextCursor = new Date(runStartedAt.getTime() - CURSOR_OVERLAP_MIN * 60000).toISOString();
  await sb.from("google_tasks_sync_state").upsert({
    user_id: userId,
    cursor_at: nextCursor,
    last_run_at: runStartedAt.toISOString(),
    last_ok_at: out.error ? (stateRow?.last_ok_at || null) : runStartedAt.toISOString(),
    pushed: out.pushed, pulled: out.pulled,
    last_error: out.error || (truncated ? "Hit this run's ceiling — the rest come through on the next pass." : null),
  }, { onConflict: "user_id" });

  if (truncated && !out.error) out.skipped = "truncated";
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = serviceClient();
  if (!sb) return json({ error: "server not configured" }, 500);

  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const cronSecret = Deno.env.get("GTASKS_CRON_SECRET") || "";
  const isCron = !!cronSecret && bearer === cronSecret;

  let callerId: string | null = null;
  let callerAccess: string[] = [];
  if (!isCron) {
    if (!bearer) return json({ error: "unauthorized" }, 401);
    const { data: { user }, error } = await sb.auth.getUser(bearer);
    if (error || !user) return json({ error: "unauthorized" }, 401);
    const { data: p } = await sb.from("profiles").select("status,access").eq("id", user.id).maybeSingle();
    if (!p || p.status !== "active") return json({ error: "Account is not active." }, 403);
    callerId = user.id;
    callerAccess = Array.isArray(p.access) ? p.access : [];
  }

  const body = await req.json().catch(() => ({}));
  const action = body.action || "run";

  if (action === "status") {
    if (!callerId) return json({ error: "unauthorized" }, 401);
    const { data } = await sb.from("google_tasks_sync_state").select("*").eq("user_id", callerId).maybeSingle();
    const { data: tok } = await sb.from("google_tokens").select("user_id").eq("user_id", callerId).maybeSingle();
    return json({ ok: true, connected: !!tok, state: data || null });
  }

  const { data: docs } = await sb.from("agenda_docs").select("*").eq("active", true);
  const agendaByFile = new Map<string, any>();
  for (const d of (docs || [])) agendaByFile.set(d.drive_file_id, d);

  const dry = body.dry === true;

  if (action === "run_me") {
    if (!callerId) return json({ error: "unauthorized" }, 401);
    writeDeadline = Date.now() + WRITE_BUDGET_MS;
    const r = await syncUser(sb, callerId, agendaByFile, dry);
    return json({ ok: !r.error, dry, result: r });
  }

  // Answers one question and changes nothing: will Google accept a status
  // write on a task that came from a Doc? It re-sends each imported task's
  // CURRENT status, so no checkbox moves and no agenda is edited — a rejection
  // here is the only thing that would stop "tick it in the app, watch it tick
  // in the agenda" from working.
  if (action === "probe") {
    if (!isCron && !callerAccess.some((a) => a === "admin" || a === "operations")) {
      return json({ error: "forbidden" }, 403);
    }
    const { data: links } = await sb.from("google_task_links").select("*").eq("origin", "pull").limit(5);
    const checked: any[] = [];
    for (const l of (links || [])) {
      const { data: tok } = await sb.from("google_tokens").select("refresh_token").eq("user_id", l.user_id).maybeSingle();
      if (!tok?.refresh_token) continue;
      try {
        const token = await googleAccessToken(tok.refresh_token);
        const cur = await gfetch(token, `/lists/${encodeURIComponent(l.google_list_id)}/tasks/${encodeURIComponent(l.google_task_id)}`);
        await gfetch(token, `/lists/${encodeURIComponent(l.google_list_id)}/tasks/${encodeURIComponent(l.google_task_id)}`,
          { method: "PATCH", body: JSON.stringify({ status: cur.status }) });
        checked.push({ task: cur.title, status: cur.status, writable: true });
      } catch (e) {
        checked.push({ task: l.google_task_id, writable: false, error: String((e as any)?.message || e) });
      }
    }
    return json({ ok: true, checked });
  }

  if (action === "run") {
    // The whole-team run is the cron's job; a human may trigger it too, but
    // only an admin/operations one.
    if (!isCron && !callerAccess.some((a) => a === "admin" || a === "operations")) {
      return json({ error: "forbidden" }, 403);
    }
    writeDeadline = Date.now() + WRITE_BUDGET_MS;
    const { data: connected } = await sb.from("google_tokens").select("user_id");
    const results: SyncResult[] = [];
    for (const row of (connected || [])) {
      try { results.push(await syncUser(sb, row.user_id, agendaByFile, dry)); }
      catch (e) { results.push({ user_id: row.user_id, pushed: 0, pulled: 0, updated: 0, removed: 0, error: String((e as any)?.message || e) }); }
    }
    return json({
      ok: true,
      dry,
      people: results.length,
      pushed: results.reduce((n, r) => n + r.pushed, 0),
      pulled: results.reduce((n, r) => n + r.pulled, 0),
      updated: results.reduce((n, r) => n + r.updated, 0),
      removed: results.reduce((n, r) => n + r.removed, 0),
      results,
    });
  }

  return json({ error: "unknown action" }, 400);
});
