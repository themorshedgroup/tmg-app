// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: google-tasks-sync
//
// Keeps each person's Google Tasks and their TMG My Tasks in step, both ways.
//
//   OUT  every TMG task ASSIGNED to someone appears in that person's Google
//        Tasks, so an agent sees their work on their phone without opening
//        the app. A task with nobody on it is left alone — a CTC file's
//        checklist is a shared pool until someone picks an item up.
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
const MAX_PULL_PER_RUN   = 200;
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
const toGoogleStatus = (s: string) => (s === "done" ? "completed" : "needsAction");
const fromGoogleStatus = (s: string) => (s === "completed" ? "done" : "todo");

type SyncResult = { user_id: string; pushed: number; pulled: number; updated: number; skipped?: string; error?: string; sample?: string[]; agenda?: { importable: number; already_done: number; stale: number } };

// `dry` reads both sides and reports exactly what a real run would do, without
// writing a single row here or in anybody's Google account. It exists because
// the first live run touches real teammates' phones, and "look before you
// write" is cheap when the read is the same code path.
async function syncUser(sb: any, userId: string, agendaByFile: Map<string, any>, dry = false): Promise<SyncResult> {
  const out: SyncResult = { user_id: userId, pushed: 0, pulled: 0, updated: 0 };
  const sample: string[] = [];
  // Dry-run only: how the agenda backlog splits, so the size of a first
  // import is a known number rather than a surprise.
  let seenOpen = 0, seenDone = 0, seenStale = 0;

  const { data: tok } = await sb.from("google_tokens").select("refresh_token").eq("user_id", userId).maybeSingle();
  if (!tok?.refresh_token) { out.skipped = "not_connected"; return out; }

  // Respect the per-person off switch. Absent prefs mean on: the sync is
  // meant to just work, and only someone who has deliberately turned it off
  // should be skipped.
  const { data: prof } = await sb.from("profiles").select("calendar_prefs,status").eq("id", userId).maybeSingle();
  if (!prof || prof.status !== "active") { out.skipped = "inactive"; return out; }
  if (prof.calendar_prefs && prof.calendar_prefs.autoSyncTasks === false) { out.skipped = "opted_out"; return out; }

  let token: string;
  try { token = await googleAccessToken(tok.refresh_token); }
  catch (e) { out.error = "needs_reconnect: " + String((e as any)?.message || e); return out; }

  const { data: stateRow } = await sb.from("google_tasks_sync_state").select("*").eq("user_id", userId).maybeSingle();
  const cursor: string | null = stateRow?.cursor_at || null;
  const runStartedAt = new Date();

  // Every link this person already has, indexed both ways.
  const { data: linkRows } = await sb.from("google_task_links").select("*").eq("user_id", userId);
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
          const want = fromGoogleStatus(gt.status);
          const googleUpdated = gt.updated ? new Date(gt.updated) : null;
          const tmgUpdated = t.updated_at ? new Date(t.updated_at) : null;
          const googleIsNewer = googleUpdated && (!tmgUpdated || googleUpdated > tmgUpdated);
          if (want !== t.status && googleIsNewer) {
            if (sample.length < 8) sample.push(`status ${t.status}→${want}: ${gt.title || ""}`);
            if (!dry) {
              const patch: any = { status: want, updated_at: new Date().toISOString() };
              if (want === "done") patch.completed_at = gt.completed || new Date().toISOString();
              else patch.completed_at = null;
              await sb.from("tasks").update(patch).eq("id", t.id);
            }
            out.updated++;
          }
          if (!dry) {
            await sb.from("google_task_links")
              .update({ google_updated: gt.updated || null, synced_at: new Date().toISOString() })
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
  const { data: mine } = await sb.from("task_people").select("task_id").eq("user_id", userId).eq("role", "assignee");
  const myIds = [...new Set((mine || []).map((r: any) => r.task_id))];
  const cutoff = new Date(Date.now() - DONE_LOOKBACK_DAYS * 86400000).toISOString();
  for (let i = 0; i < myIds.length; i += 150) {
    const { data: batch } = await sb.from("tasks")
      .select("id,title,status,due_at,updated_at,completed_at")
      .in("id", myIds.slice(i, i + 150));
    for (const t of (batch || [])) {
      // Old finished work stays out of it — see DONE_LOOKBACK_DAYS.
      if (t.status === "done" && (!t.completed_at || t.completed_at < cutoff)) continue;
      const link = byTaskId.get(t.id);
      const payload = { title: t.title, status: toGoogleStatus(t.status), due: toGoogleDue(t.due_at) };

      if (!link) {
        if (out.pushed >= MAX_PUSH_PER_RUN) { truncated = true; continue; }
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
        // Google restricts edits on tasks that came from a Doc. If it refuses,
        // the app's own status stays the truth and the reason is recorded
        // rather than swallowed.
        out.error = String((e as any)?.message || e);
      }
    }
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
    const { data: connected } = await sb.from("google_tokens").select("user_id");
    const results: SyncResult[] = [];
    for (const row of (connected || [])) {
      try { results.push(await syncUser(sb, row.user_id, agendaByFile, dry)); }
      catch (e) { results.push({ user_id: row.user_id, pushed: 0, pulled: 0, updated: 0, error: String((e as any)?.message || e) }); }
    }
    return json({
      ok: true,
      dry,
      people: results.length,
      pushed: results.reduce((n, r) => n + r.pushed, 0),
      pulled: results.reduce((n, r) => n + r.pulled, 0),
      updated: results.reduce((n, r) => n + r.updated, 0),
      results,
    });
  }

  return json({ error: "unknown action" }, 400);
});
