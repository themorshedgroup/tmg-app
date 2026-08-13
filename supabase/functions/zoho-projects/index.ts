// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: zoho-projects
// Proxies Zoho PROJECTS API calls server-side (OAuth secrets never reach the
// browser). This is a SEPARATE Zoho product from the CRM zoho-crm talks to —
// different API domain, different portal-scoped OAuth — so it gets its own
// connection table and its own token-cache pattern, mirrored from zoho-crm's
// (see plan: hidden-wiggling-lamport §"What already exists").
//
// Deploy: Supabase Dashboard → Edge Functions → new function `zoho-projects`
//   Paste this whole file, then click Deploy.
//
// Secrets required (same Zoho API-console client as zoho-crm — a single
// registered Zoho OAuth app can request scopes across multiple Zoho products,
// so no new client needs registering, only a new consent with
// ZohoProjects.* scopes added):
//   ZOHO_CLIENT_ID       = same Zoho Self Client / Server-based app client id as zoho-crm
//   ZOHO_CLIENT_SECRET   = that client's secret
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// The org's Zoho Projects refresh token + portal id are stored in the
// `zoho_projects_connection` table (one row, service-role only — deliberately
// NOT the same row as zoho_connection, so a Projects reconnect can never risk
// breaking live CRM sync).
//
// Field scope is deliberately narrow (plan §2.1): only name/description/
// dates/priority/status sync — nothing else is read or written here.
//
// Zoho Projects specifics vs. the CRM API (zoho-crm/index.ts):
//   - Base domain is projectsapi.zoho.com, not www.zohoapis.com.
//   - Hierarchy is Portal → Project → Tasklist → Task (portal id is fixed per
//     connection; project id is per CTC file, stored on `projects.zoho_project_id`).
//   - Updates are POST to the same-id path, NOT PUT/PATCH.
//   - Dates are MM-DD-YYYY strings, not ISO — see isoToZohoDate/zohoDateToIso.
//   - Rate limit is 100 calls/2 min per token (far tighter than CRM) — every
//     action here should stay a single call per invocation where possible.
//
// POST actions:
//   list_portals, list_projects, get_project, create_project, update_project,
//   list_tasklists, create_tasklist, list_tasks, get_task, create_task,
//   update_task, delete_task
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key);
}

// Verifies the caller's Supabase session and requires an ACTIVE TMG profile.
// Identical gate to zoho-crm's authorizeCaller.
async function authorizeCaller(req: Request) {
  const sb = serviceClient();
  if (!sb)
    return { ok: false as const, status: 500, error: "Server auth not configured." };

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token)
    return { ok: false as const, status: 401, error: "Sign in required." };

  const {
    data: { user },
    error,
  } = await sb.auth.getUser(token);
  if (error || !user)
    return { ok: false as const, status: 401, error: "Invalid or expired session." };

  const { data: profile, error: pErr } = await sb
    .from("profiles")
    .select("status")
    .eq("id", user.id)
    .single();
  if (pErr || !profile)
    return { ok: false as const, status: 403, error: "Account pending approval." };
  if (profile.status !== "active")
    return { ok: false as const, status: 403, error: "Account is not active." };

  return { ok: true as const, userId: user.id, sb };
}

// ── Zoho OAuth: refresh token → access token (same mechanics as zoho-crm's
// mintZohoToken — the accounts.zoho.com token endpoint is shared across every
// Zoho product; only the resulting token's SCOPES differ per connection). ──
async function mintZohoToken(
  refreshToken: string,
  accountsUrl = "https://accounts.zoho.com"
): Promise<{ access_token: string; expires_at: string }> {
  const clientId = Deno.env.get("ZOHO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret)
    throw new Error("ZOHO_CLIENT_ID and ZOHO_CLIENT_SECRET must be set.");

  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const err = String(data.error || "").toLowerCase();
    const desc = String(data.error_description || "").toLowerCase();
    if (err === "access denied" || err === "access_denied" || desc.includes("too many requests"))
      throw new Error("Zoho is rate-limiting token requests right now (too many in a short time). Wait a minute and try again.");
    throw new Error(data.error_description || data.error || "Failed to refresh Zoho token");
  }
  const expiresIn = Number(data.expires_in) || 3600;
  return {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

// High-level: reuse the cached token until 5 min from expiry, same caching
// posture as zoho-crm (Zoho Projects' own rate limit is on API CALLS, not
// token mints, but minting on every request would still be wasteful/risky).
async function getZohoToken(sb: any, conn: any): Promise<string> {
  const BUFFER_MS = 5 * 60 * 1000;
  const exp = conn.access_token_expires_at ? Date.parse(conn.access_token_expires_at) : 0;
  if (conn.access_token && exp && exp - Date.now() > BUFFER_MS) {
    return conn.access_token;
  }
  const minted = await mintZohoToken(conn.refresh_token, conn.accounts_url || "https://accounts.zoho.com");
  try {
    await sb
      .from("zoho_projects_connection")
      .update({ access_token: minted.access_token, access_token_expires_at: minted.expires_at })
      .eq("refresh_token", conn.refresh_token);
  } catch (_) { /* cache write is best-effort */ }
  conn.access_token = minted.access_token;
  conn.access_token_expires_at = minted.expires_at;
  return minted.access_token;
}

// Collapses concurrent 401-triggered remints within one invocation into a
// single remint, same guard as zoho-crm's invalidateAndRemint.
async function invalidateAndRemint(sb: any, conn: any): Promise<string> {
  if (!conn._remintPromise) {
    conn._remintPromise = (async () => {
      conn.access_token = null;
      conn.access_token_expires_at = null;
      try {
        await sb
          .from("zoho_projects_connection")
          .update({ access_token: null, access_token_expires_at: null })
          .eq("refresh_token", conn.refresh_token);
      } catch (_) { /* best-effort */ }
      return await getZohoToken(sb, conn);
    })().catch((e: any) => {
      conn._remintPromise = null;
      throw e;
    });
  }
  return conn._remintPromise;
}

// Wraps fetch with the Zoho-oauthtoken header; remints once on 401 and replays.
async function zohoFetch(
  sb: any,
  conn: any,
  accessToken: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const withAuth = (token: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers || {}), Authorization: "Zoho-oauthtoken " + token },
  });
  let res = await fetch(url, withAuth(accessToken));
  if (res.status === 401) {
    const fresh = await invalidateAndRemint(sb, conn);
    res = await fetch(url, withAuth(fresh));
  }
  return res;
}

// ── Load the single org Zoho Projects connection row ──────────────────
async function loadConnection(sb: any) {
  const { data, error } = await sb
    .from("zoho_projects_connection")
    .select("*")
    .limit(1)
    .single();
  if (error || !data?.refresh_token || !data?.portal_id)
    throw new Error("Zoho Projects connection not configured. Ask an admin to connect a portal first.");
  return data;
}

// ── Date conversion: TMG uses ISO timestamptz, Zoho Projects uses MM-DD-YYYY ──
function isoToZohoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${mm}-${dd}-${yyyy}`;
}
function zohoDateToIso(mmddyyyy: string | null | undefined): string | null {
  if (!mmddyyyy) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(mmddyyyy.trim());
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ── Priority / status mapping — deliberately lenient (case-insensitive
// substring match), because Zoho Projects' exact label set is portal-
// customizable and hasn't been confirmed against the real pilot portal yet
// (plan §2.1 flags this explicitly: confirm live before hardcoding further).
// A strict/exact map would silently drop values the first time a portal uses
// a label we didn't anticipate; this degrades to a sane default instead. ──
function tmgPriorityToZoho(p: string | null | undefined): string {
  if (p === "high") return "High";
  if (p === "low") return "Low";
  return "Medium"; // TMG's 'medium' default
}
function zohoPriorityToTmg(p: string | null | undefined): string {
  const s = (p || "").toLowerCase();
  if (s.includes("high") || s.includes("urgent")) return "high";
  if (s.includes("low") || s === "none") return "low";
  return "medium";
}
function tmgStatusToZoho(s: string | null | undefined): string {
  if (s === "done") return "Closed";
  if (s === "in_progress") return "In Progress";
  return "Open"; // 'todo' and 'stuck' both fall back to Open — Zoho has no
  // native "blocked" concept to map 'stuck' onto without knowing the pilot
  // portal's custom statuses; confirm during Phase 1 whether a closer match exists.
}
function zohoStatusToTmg(s: string | null | undefined): string {
  const v = (s || "").toLowerCase();
  if (v.includes("close") || v.includes("complet")) return "done";
  if (v.includes("progress")) return "in_progress";
  return "todo";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const auth = await authorizeCaller(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    const sb = auth.sb;

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // ── List portals available to the connected Zoho account [setup] ──
    // Unlike every other action, this does NOT require an existing
    // zoho_projects_connection row — it's how an admin discovers the portal_id
    // to store when first connecting. Needs a raw access token passed in from
    // a one-off OAuth exchange the admin just completed (body.access_token),
    // since there's no connection row yet to load one from.
    if (action === "list_portals") {
      const accessToken = (body.access_token || "").toString().trim();
      if (!accessToken) return json({ error: "Missing access_token (first-time setup only)." }, 400);
      const r = await fetch("https://projectsapi.zoho.com/restapi/portals/", {
        headers: { Authorization: "Zoho-oauthtoken " + accessToken },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho portals error", detail: d }, r.status);
      const portals = (d.portals || []).map((p: any) => ({ id: p.id_string || String(p.id), name: p.name }));
      return json({ portals }, 200);
    }

    // Every action below needs a real, saved connection.
    const conn = await loadConnection(sb);
    const accessToken = await getZohoToken(sb, conn);
    const apiDomain = conn.api_domain || "projectsapi.zoho.com";
    const portalBase = `https://${apiDomain}/restapi/portal/${conn.portal_id}`;

    // ── List/get projects in the connected portal [link picker] ────────
    if (action === "list_projects") {
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/`, {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho projects list error", detail: d }, r.status);
      const projects = (d.projects || []).map((p: any) => ({
        id: p.id_string || String(p.id),
        name: p.name,
        status: p.status || null,
      }));
      return json({ projects }, 200);
    }

    if (action === "get_project") {
      const id = (body.project_id || "").toString().trim();
      if (!id) return json({ error: "Missing project_id." }, 400);
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${id}/`, {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho project error", detail: d }, r.status);
      const p = (d.projects || [])[0] || null;
      if (!p) return json({ project: null }, 200);
      return json({
        project: {
          id: p.id_string || String(p.id),
          name: p.name,
          start_date: zohoDateToIso(p.start_date),
          end_date: zohoDateToIso(p.end_date),
        },
      }, 200);
    }

    if (action === "create_project") {
      const name = (body.name || "").toString().trim();
      if (!name) return json({ error: "Missing name." }, 400);
      const form = new URLSearchParams({ name });
      if (body.start_date) { const zd = isoToZohoDate(body.start_date); if (zd) form.set("start_date", zd); }
      if (body.end_date) { const zd = isoToZohoDate(body.end_date); if (zd) form.set("end_date", zd); }
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Could not create Zoho project", detail: d }, r.status);
      const p = (d.projects || [])[0];
      return json({ ok: true, id: p ? (p.id_string || String(p.id)) : null }, 200);
    }

    // Zoho Projects updates a project via POST to the same-id path (not PUT).
    // Only name/start_date/end_date are ever sent — TMG's own project status
    // is deliberately never pushed to Zoho (plan §2.1).
    if (action === "update_project") {
      const id = (body.project_id || "").toString().trim();
      if (!id) return json({ error: "Missing project_id." }, 400);
      const form = new URLSearchParams();
      if (typeof body.name === "string") form.set("name", body.name);
      if ("start_date" in body) { const zd = isoToZohoDate(body.start_date); if (zd) form.set("start_date", zd); }
      if ("end_date" in body) { const zd = isoToZohoDate(body.end_date); if (zd) form.set("end_date", zd); }
      if (![...form.keys()].length) return json({ error: "Nothing to update." }, 400);
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${id}/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Could not update Zoho project", detail: d }, r.status);
      return json({ ok: true, id }, 200);
    }

    // ── Tasklists — a task needs one to live in. Whether Zoho auto-provides
    // a default tasklist on project creation is unconfirmed (plan §2 flags
    // this); list_tasklists lets the caller check before deciding whether
    // create_tasklist is needed. ──
    if (action === "list_tasklists") {
      const projectId = (body.project_id || "").toString().trim();
      if (!projectId) return json({ error: "Missing project_id." }, 400);
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${projectId}/tasklists/`, {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho tasklists error", detail: d }, r.status);
      const tasklists = (d.tasklists || []).map((t: any) => ({ id: t.id_string || String(t.id), name: t.name }));
      return json({ tasklists }, 200);
    }

    if (action === "create_tasklist") {
      const projectId = (body.project_id || "").toString().trim();
      const name = (body.name || "TMG Tasks").toString().trim();
      if (!projectId) return json({ error: "Missing project_id." }, 400);
      const form = new URLSearchParams({ name });
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${projectId}/tasklists/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Could not create tasklist", detail: d }, r.status);
      const t = (d.tasklists || [])[0];
      return json({ ok: true, id: t ? (t.id_string || String(t.id)) : null }, 200);
    }

    // ── List tasks in a project — this doubles as the poll cursor. `since`
    // (an ISO timestamp) is meant to filter to tasks changed after that time,
    // but the exact Zoho query param for this is UNCONFIRMED against live
    // docs (plan §4 flags this) — passed through as `last_modified_time` as
    // the best-documented guess; verify against a real sandbox response
    // during Phase 1 and adjust here if Zoho ignores/rejects it. Falls back
    // to returning every task in the project (still filtered client-side by
    // the caller) if the param has no effect, so the poller stays correct
    // even if this specific param turns out wrong — just less efficient
    // until confirmed. ──
    if (action === "list_tasks") {
      const projectId = (body.project_id || "").toString().trim();
      if (!projectId) return json({ error: "Missing project_id." }, 400);
      const u = new URL(`${portalBase}/projects/${projectId}/tasks/`);
      if (body.since) u.searchParams.set("last_modified_time", body.since);
      const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho tasks list error", detail: d }, r.status);
      const tasks = (d.tasks || []).map(mapZohoTask);
      return json({ tasks }, 200);
    }

    if (action === "get_task") {
      const projectId = (body.project_id || "").toString().trim();
      const taskId = (body.task_id || "").toString().trim();
      if (!projectId || !taskId) return json({ error: "Missing project_id or task_id." }, 400);
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${projectId}/tasks/${taskId}/`, {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho task error", detail: d }, r.status);
      const t = (d.tasks || [])[0] || null;
      return json({ task: t ? mapZohoTask(t) : null }, 200);
    }

    // Only the fields in plan §2.1 are ever sent: name/description/dates/
    // priority/status. tasklist_id is required to place the task somewhere.
    if (action === "create_task") {
      const projectId = (body.project_id || "").toString().trim();
      const tasklistId = (body.tasklist_id || "").toString().trim();
      const name = (body.title || "").toString().trim();
      if (!projectId || !name) return json({ error: "Missing project_id or title." }, 400);
      const form = new URLSearchParams({ name });
      if (tasklistId) form.set("tasklist_id", tasklistId);
      if (body.description) form.set("description", String(body.description));
      if (body.due_at) { const zd = isoToZohoDate(body.due_at); if (zd) form.set("end_date", zd); }
      if (body.priority) form.set("priority", tmgPriorityToZoho(body.priority));
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${projectId}/tasks/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Could not create Zoho task", detail: d }, r.status);
      const t = (d.tasks || [])[0];
      if (!t) return json({ error: "Zoho did not return the created task.", detail: d }, 502);
      return json({ ok: true, task: mapZohoTask(t) }, 200);
    }

    if (action === "update_task") {
      const projectId = (body.project_id || "").toString().trim();
      const taskId = (body.task_id || "").toString().trim();
      if (!projectId || !taskId) return json({ error: "Missing project_id or task_id." }, 400);
      const form = new URLSearchParams();
      if (typeof body.title === "string") form.set("name", body.title);
      if ("description" in body) form.set("description", String(body.description || ""));
      if ("due_at" in body) { const zd = isoToZohoDate(body.due_at); if (zd) form.set("end_date", zd); }
      if (body.priority) form.set("priority", tmgPriorityToZoho(body.priority));
      if (body.status) form.set("status", tmgStatusToZoho(body.status));
      if (![...form.keys()].length) return json({ error: "Nothing to update." }, 400);
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${projectId}/tasks/${taskId}/`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Could not update Zoho task", detail: d }, r.status);
      return json({ ok: true, id: taskId }, 200);
    }

    if (action === "delete_task") {
      const projectId = (body.project_id || "").toString().trim();
      const taskId = (body.task_id || "").toString().trim();
      if (!projectId || !taskId) return json({ error: "Missing project_id or task_id." }, 400);
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${projectId}/tasks/${taskId}/`, {
        method: "DELETE",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Could not delete Zoho task", detail: d }, r.status);
      return json({ ok: true, id: taskId }, 200);
    }

    // ── Manual "Sync now" — a signed-in-user-triggered version of the same
    // pull-and-reconcile loop zoho-projects-poll runs on its cron schedule,
    // scoped to ONE local project (the "Sync now" button in ProjectsSurface's
    // detailFields, plan §3.7). Duplicated rather than shared with the poll
    // function, matching this codebase's self-contained-edge-function
    // convention — keep the reconcile logic in sync if it's ever corrected.
    if (action === "sync_now") {
      const localProjectId = (body.project_id || "").toString().trim();
      if (!localProjectId) return json({ error: "Missing project_id." }, 400);
      const { data: proj } = await sb.from("projects")
        .select("id,name,zoho_project_id,zoho_last_synced_at")
        .eq("id", localProjectId).eq("record_type", "ctc_file").single();
      if (!proj || !proj.zoho_project_id) return json({ error: "This CTC file isn't linked to a Zoho project." }, 400);

      const u = new URL(`${portalBase}/projects/${proj.zoho_project_id}/tasks/`);
      if (proj.zoho_last_synced_at) u.searchParams.set("last_modified_time", proj.zoho_last_synced_at);
      const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho tasks error", detail: d }, r.status);

      const zTasks = (d.tasks || []).map(mapZohoTask);
      let pulled = 0, conflicts = 0, created = 0;

      for (const zt of zTasks) {
        const { data: local } = await sb.from("tasks").select("*")
          .eq("project_id", proj.id).eq("zoho_task_id", zt.id).maybeSingle();

        if (!local) {
          const { data: inserted } = await sb.from("tasks").insert({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status, project_id: proj.id,
            zoho_task_id: zt.id, zoho_last_synced_at: new Date().toISOString(),
            zoho_last_modified_time: zt.last_modified_time,
          }).select().single();
          if (inserted) {
            await sb.from("task_activity").insert({ task_id: inserted.id, kind: "system", content: "Task created in Zoho Projects" });
            created++;
          }
          continue;
        }

        const localChangedSinceSync = local.updated_at && local.zoho_last_synced_at
          ? new Date(local.updated_at) > new Date(local.zoho_last_synced_at)
          : !local.zoho_last_synced_at;
        const zohoChangedSinceSync = zt.last_modified_time !== local.zoho_last_modified_time;
        if (!zohoChangedSinceSync) continue;

        if (localChangedSinceSync) {
          const localMs = local.updated_at ? new Date(local.updated_at).getTime() : 0;
          const zohoMs = zt.last_modified_time || 0;
          const fields = ["title", "description", "due_at", "priority", "status"];
          const changedField = fields.find((f) => (local as any)[f] !== (zt as any)[f]) || "title";
          if (zohoMs > localMs) {
            await sb.from("tasks").update({
              title: zt.title, description: zt.description, due_at: zt.due_at,
              priority: zt.priority, status: zt.status,
              zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
            }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String((local as any)[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "zoho_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}" — Zoho's edit was more recent; Zoho's value was kept.` });
          } else {
            const form = new URLSearchParams({
              name: local.title || "", description: local.description || "",
              priority: tmgPriorityToZoho(local.priority), status: tmgStatusToZoho(local.status),
            });
            const zd = isoToZohoDate(local.due_at); if (zd) form.set("end_date", zd);
            await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${proj.zoho_project_id}/tasks/${zt.id}/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
            await sb.from("tasks").update({ zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: Date.now() }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String((local as any)[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "tmg_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}" — TMG's edit was more recent; TMG's value was kept and pushed to Zoho.` });
          }
          conflicts++;
        } else {
          await sb.from("tasks").update({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status,
            zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
          }).eq("id", local.id);
          pulled++;
        }
      }

      await sb.from("projects").update({ zoho_last_synced_at: new Date().toISOString() }).eq("id", proj.id);
      return json({ ok: true, pulled, created, conflicts }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

// Normalizes a raw Zoho task record down to exactly the fields TMG syncs
// (plan §2.1) — nothing else from Zoho's task object is ever surfaced.
function mapZohoTask(t: any) {
  return {
    id: t.id_string || String(t.id),
    title: t.name || "",
    description: t.description || null,
    due_at: zohoDateToIso(t.end_date),
    priority: zohoPriorityToTmg(t.priority),
    status: zohoStatusToTmg(t.status?.name || t.status),
    last_modified_time: t.last_modified_time_long != null ? Number(t.last_modified_time_long) : null,
  };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
