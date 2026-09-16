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
// dates/priority/status sync. The one addition beyond that (2026-09-11,
// Bug B fix — see plan: hidden-wiggling-lamport addendum) is task OWNERSHIP:
// create_task/update_task now also accept assignee_emails and, when given,
// resolve them to Zoho Projects user ids and set person_responsible. This
// needed its own resolver (resolveZohoOwnerIds below) because Zoho Projects
// user ids are a DIFFERENT id space from profiles.zoho_user_id (that column
// is Zoho CRM's org — confirmed a different numeric namespace), and Zoho's
// task API only accepts ids, never emails.
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
//   list_tasklists, create_tasklist, list_tasks, count_tasks_by_tasklist,
//   get_task, create_task, update_task, delete_task, sync_now,
//   backfill_zoho_links, audit_transaction_fields
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

  // Server/ops caller: the service-role key itself (never present in browsers)
  // acts as an admin identity — same pattern as zoho-crm's authorizeCaller,
  // used for ops tooling like bulk task cleanup.
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (svcKey && token === svcKey) {
    return { ok: true as const, userId: "service", sb, isService: true as const };
  }

  const {
    data: { user },
    error,
  } = await sb.auth.getUser(token);
  if (error || !user) {
    // Ops tooling, second door — the same probe zoho-crm uses, for the same
    // reason. The string match above only recognises an ops caller while BOTH
    // sides hold the identical secret, and this project has more than one
    // valid secret key (the newer `sb_secret_…` format is issued alongside the
    // legacy JWT). A CLI holding a different-but-equally-valid key was being
    // told "invalid or expired session", which is not what had happened.
    //
    // So ask Supabase what the token can DO rather than what it looks like.
    // listUsers is an Auth ADMIN call: anon and publishable keys are refused
    // by Supabase itself, and a signed-in user's JWT never reaches this line
    // (it resolves at getUser above). Passing it therefore means service-role,
    // which is exactly the privilege the string match already grants — no new
    // access, just a second spelling of the same key.
    try {
      const probe = createClient(Deno.env.get("SUPABASE_URL") || "", token);
      const { error: probeErr } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (!probeErr) return { ok: true as const, userId: "service", sb, isService: true as const };
    } catch { /* not a service key — fall through to the 401 below */ }
    return { ok: false as const, status: 401, error: "Invalid or expired session." };
  }

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

// ── Portal users cache — resolves TMG assignee emails to Zoho Projects user
// ids for person_responsible. Cached on zoho_projects_connection (portal-
// wide, not project-scoped) because GET /users/ is a real Zoho API call and
// task creates/updates fire far more often than the portal roster changes.
// Refreshed when the cache is missing, older than the TTL, or doesn't
// contain an email we need right now — so a newly-added Zoho user resolves
// on their very first task instead of waiting out the full TTL. A failed
// refresh falls through to whatever cache already exists (possibly empty)
// rather than blocking the task write — a missing owner is recoverable, a
// lost task isn't. ──
const PORTAL_USERS_TTL_MS = 30 * 60 * 1000;

async function resolveZohoOwnerIds(
  sb: any, conn: any, accessToken: string, portalBase: string, emails: string[]
): Promise<{ ids: string[]; missing: string[] }> {
  const wanted = emails.map((e) => (e || "").toLowerCase().trim()).filter(Boolean);
  if (!wanted.length) return { ids: [], missing: [] };

  let cache = (conn.portal_users_cache || {}) as Record<string, string>;
  const cachedAt = conn.portal_users_cached_at ? Date.parse(conn.portal_users_cached_at) : 0;
  const stale = !cachedAt || (Date.now() - cachedAt) > PORTAL_USERS_TTL_MS;
  const missingFromCache = wanted.some((e) => !cache[e]);

  if (stale || missingFromCache) {
    const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/users/`, {});
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      const users = d.users || d.userlist || [];
      const fresh: Record<string, string> = {};
      for (const u of users) {
        const email = (u.email || "").toLowerCase().trim();
        const id = u.id_string || (u.id != null ? String(u.id) : "");
        if (email && id) fresh[email] = id;
      }
      cache = fresh;
      conn.portal_users_cache = fresh;
      conn.portal_users_cached_at = new Date().toISOString();
      try {
        await sb.from("zoho_projects_connection")
          .update({ portal_users_cache: fresh, portal_users_cached_at: conn.portal_users_cached_at })
          .eq("refresh_token", conn.refresh_token);
      } catch (_) { /* cache write is best-effort */ }
    }
  }

  const ids: string[] = [], missing: string[] = [];
  for (const e of wanted) { const id = cache[e]; if (id) ids.push(id); else missing.push(e); }
  return { ids, missing };
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

// ── Project custom fields ("Transaction Information" in Zoho's UI) ────────
// Zoho hands back the DEFINITIONS and the VALUES from two different places
// and in two different shapes:
//   definitions  GET /projects/customfields/  → [{field_id, field_name,
//                api_name, field_type, is_visible}]  (portal-wide)
//   values       inside the project itself     → custom_fields: [{"<label>":
//                "<value>"}]  — one single-key object per field, and ONLY
//                for fields that actually have a value.
// So a project with nothing filled in has no custom_fields array at all, and
// there is no way to know a field exists — let alone render it blank —
// without the definitions. We merge the two.
//
// The definitions are portal-wide and change only when an admin edits them,
// while the portal's ceiling is 100 API calls / 2 minutes, so they are cached
// for the life of the isolate: without this every project open would cost two
// Zoho calls instead of one.
let PROJECT_FIELD_DEFS: any[] | null = null;
async function projectFieldDefs(sb: any, conn: any, accessToken: string, portalBase: string) {
  if (PROJECT_FIELD_DEFS) return PROJECT_FIELD_DEFS;
  try {
    const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/customfields/`, {});
    const d = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(d.project_custom_fields)) PROJECT_FIELD_DEFS = d.project_custom_fields;
  } catch { /* leave null so the next open retries */ }
  return PROJECT_FIELD_DEFS || [];
}

// The order Zoho's own project page shows them in, which is the order the TC
// reads them in. Anything not listed keeps its definition order and lands
// after these, so a field added in Zoho tomorrow still appears.
const PROJECT_FIELD_ORDER = [
  "Agent", "Property Website", "MLS Active Date", "Effective Date",
  "Inspection Due Date", "Option Period End Date", "Tiltle Commit Obj Date",
  "Appraisal Due Date", "Finance Period End Date", "Closing Date",
];

function mergeProjectCustomFields(defs: any[], raw: any) {
  // values: [{label: value}, …] → one flat lookup
  const values: Record<string, any> = {};
  for (const entry of (raw && raw.custom_fields) || []) {
    if (entry && typeof entry === "object") {
      for (const k of Object.keys(entry)) values[k] = entry[k];
    }
  }
  const visible = (defs || []).filter((f: any) => f && f.is_visible !== false);
  const rank = (name: string) => {
    const i = PROJECT_FIELD_ORDER.indexOf(name);
    return i === -1 ? PROJECT_FIELD_ORDER.length : i;
  };
  const ordered = visible
    .map((f: any, i: number) => ({ f, i }))
    .sort((a, b) => (rank(a.f.field_name) - rank(b.f.field_name)) || (a.i - b.i))
    .map((x) => x.f);

  return ordered.map((f: any) => {
    const v = values[f.field_name];
    let value = v === undefined || v === null || String(v).trim() === "" ? null : String(v).trim();
    // Dates arrive MM-DD-YYYY. Keep them as a plain YYYY-MM-DD string rather
    // than a timestamp — a date-only field parsed through Date() shifts a day
    // for anyone east or west of the server.
    if (value && f.field_type === "date") {
      const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
      if (m) value = `${m[3]}-${m[1]}-${m[2]}`;
    }
    return {
      name: f.field_name,
      api_name: f.api_name || null,
      type: f.field_type || "single_line",
      value,
    };
  });
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

    // ── Where this portal lives on the web [link building] ────────────
    //  The browser has no idea which Zoho Projects portal the org is on --
    //  portal_id is stored here, server-side, and never leaves. But a link to
    //  a project needs it in the path, so hand back just the public base and
    //  let the page append its own project id.
    //
    //  Deliberately placed ABOVE getZohoToken: this answers from the row we
    //  already loaded, so it costs no Zoho API call and no token refresh. The
    //  portal ceiling is 100 calls per 2 minutes and this runs on every CTC
    //  file opened, so it must stay free.
    //
    //  The numeric portal id works in the URL path in place of the portal
    //  slug -- projects.zoho.com resolves it before login, so no slug needs
    //  to be discovered or stored.
    if (action === "portal_info") {
      return json({
        portal_id: conn.portal_id,
        web_base: `https://projects.zoho.com/portal/${conn.portal_id}`,
      }, 200);
    }

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
      const defs = await projectFieldDefs(sb, conn, accessToken, portalBase);
      return json({
        project: {
          id: p.id_string || String(p.id),
          name: p.name,
          start_date: zohoDateToIso(p.start_date),
          end_date: zohoDateToIso(p.end_date),
          status: p.status || null,
          owner_name: p.owner_name || null,
          custom_fields: mergeProjectCustomFields(defs, p),
        },
      }, 200);
    }

    // One-off audit: for every project in the portal, how many of the
    // project-level custom fields ("Transaction Information" section — MLS
    // Active Date, Agent, Effective Date, etc., defined portal-wide via
    // Admin > Custom Fields > Projects) actually have a value set. Read-only —
    // makes no writes to Zoho or to TMG's own tables. The value's exact
    // location in Zoho's JSON isn't documented (Zoho's own docs show the
    // definition shape but not the read shape), so findFieldValue searches a
    // few known container shapes plus one level of nesting rather than
    // assuming one.
    if (action === "audit_transaction_fields") {
      const rDefs = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/customfields/`, {});
      const dDefs = await rDefs.json().catch(() => ({}));
      if (!rDefs.ok) return json({ error: dDefs?.error || "Zoho custom fields error", detail: dDefs }, rDefs.status);
      const fields = (dDefs.project_custom_fields || []).map((f: any) => ({
        field_id: f.field_id, name: f.field_name || f.field_id,
      }));

      const projects: { id: string; name: string }[] = [];
      let index = 1;
      const range = 100;
      for (let page = 0; page < 20; page++) {
        const u = new URL(`${portalBase}/projects/`);
        u.searchParams.set("index", String(index));
        u.searchParams.set("range", String(range));
        const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: d?.error || "Zoho projects list error", detail: d }, r.status);
        const batch = d.projects || [];
        projects.push(...batch.map((p: any) => ({ id: p.id_string || String(p.id), name: p.name })));
        if (batch.length < range) break;
        index += range;
      }

      const findFieldValue = (obj: any, fieldId: string, fieldName: string, depth = 0): any => {
        if (!obj || typeof obj !== "object" || depth > 2) return undefined;
        if (fieldId in obj) return (obj as any)[fieldId];
        for (const key of ["custom_fields", "customfields", "customFields", "udfs"]) {
          const c = (obj as any)[key];
          if (Array.isArray(c)) {
            const hit = c.find((x: any) => x && (x.field_id === fieldId || x.id === fieldId || x.column_name === fieldId || x.label === fieldName || x.name === fieldName));
            if (hit) return hit.value !== undefined ? hit.value : hit.field_value;
          } else if (c && typeof c === "object" && fieldId in c) {
            return c[fieldId];
          }
        }
        for (const k of Object.keys(obj)) {
          const v = (obj as any)[k];
          if (v && typeof v === "object" && !Array.isArray(v)) {
            const found = findFieldValue(v, fieldId, fieldName, depth + 1);
            if (found !== undefined) return found;
          }
        }
        return undefined;
      };

      const results: { name: string; filled: number }[] = [];
      let firstRawKeys: string[] | null = null;
      for (const p of projects) {
        const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${p.id}/`, {});
        const d = await r.json().catch(() => ({}));
        const raw = (d.projects || [])[0] || null;
        if (!raw) { results.push({ name: p.name, filled: 0 }); continue; }
        if (!firstRawKeys) firstRawKeys = Object.keys(raw);
        let filled = 0;
        for (const f of fields) {
          const v = findFieldValue(raw, f.field_id, f.name);
          if (v !== undefined && v !== null && String(v).trim() !== "") filled++;
        }
        results.push({ name: p.name, filled });
      }

      return json({ fields, results, debug_raw_project_keys: firstRawKeys }, 200);
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
      if (body.index) u.searchParams.set("index", String(body.index));
      if (body.range) u.searchParams.set("range", String(body.range));
      const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho tasks list error", detail: d }, r.status);
      const tasks = (d.tasks || []).map(mapZohoTask);
      return json({ tasks }, 200);
    }

    // Ops-only: total live task count per tasklist, paging until Zoho returns
    // fewer than the page size. Exists to verify bulk-delete results against
    // Zoho directly rather than trusting a single capped page.
    if (action === "count_tasks_by_tasklist") {
      const projectId = (body.project_id || "").toString().trim();
      if (!projectId) return json({ error: "Missing project_id." }, 400);
      const counts: Record<string, { name: string; count: number }> = {};
      let index = 1;
      const range = 200;
      for (let page = 0; page < 50; page++) {
        const u = new URL(`${portalBase}/projects/${projectId}/tasks/`);
        u.searchParams.set("index", String(index));
        u.searchParams.set("range", String(range));
        const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: d?.error || "Zoho tasks list error", detail: d, partial: counts }, r.status);
        const tasks = (d.tasks || []).map(mapZohoTask);
        for (const t of tasks) {
          const tl = t.tasklist_id || "none";
          if (!counts[tl]) counts[tl] = { name: t.tasklist_name || "?", count: 0 };
          counts[tl].count++;
        }
        if (tasks.length < range) break;
        index += range;
      }
      return json({ counts }, 200);
    }

    // Diagnostic/admin: raw portal user roster, bypassing the cache. Not used
    // by the normal sync path (that goes through resolveZohoOwnerIds) — this
    // exists to verify email matching against the real pilot portal by hand.
    if (action === "list_users") {
      const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/users/`, {});
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error || "Zoho users list error", detail: d }, r.status);
      const users = (d.users || d.userlist || []).map((u: any) => ({
        id: u.id_string || String(u.id), name: u.name || null, email: u.email || null,
      }));
      return json({ users }, 200);
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
      const assigneeEmails: string[] = Array.isArray(body.assignee_emails) ? body.assignee_emails : [];
      if (assigneeEmails.length) {
        const { ids } = await resolveZohoOwnerIds(sb, conn, accessToken, portalBase, assigneeEmails);
        if (ids.length) form.set("person_responsible", ids.join(","));
      }
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
      if ("due_at" in body) {
        const zd = isoToZohoDate(body.due_at);
        if (zd) {
          form.set("end_date", zd);
          // Zoho treats start_date as a companion of end_date: send a due date
          // for a task that has no start date and Zoho fills the start in
          // itself, with the due date, producing a false one-day task. One
          // extra GET (a due-date edit is rare, and the portal ceiling is 100
          // calls / 2 min) buys back the start date Zoho already has so it can
          // be re-sent untouched. If the task genuinely has no start date there
          // is nothing to preserve, so this sends end_date alone exactly as
          // before rather than inventing a start date of TMG's own.
          const gr = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${projectId}/tasks/${taskId}/`, {});
          const gd = await gr.json().catch(() => ({}));
          const existingStart = gr.ok ? ((gd.tasks || [])[0]?.start_date || null) : null;
          if (existingStart) form.set("start_date", existingStart);
        }
      }
      if (body.priority) form.set("priority", tmgPriorityToZoho(body.priority));
      if (body.status) form.set("status", tmgStatusToZoho(body.status));
      const assigneeEmails: string[] = Array.isArray(body.assignee_emails) ? body.assignee_emails : [];
      if (assigneeEmails.length) {
        const { ids } = await resolveZohoOwnerIds(sb, conn, accessToken, portalBase, assigneeEmails);
        if (ids.length) form.set("person_responsible", ids.join(","));
      }
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
      // record_type gate matches ZOHO_SYNCABLE_KINDS in tasks.html — ctc_file
      // + project (e.g. "Accountability"), not rock.
      const { data: proj } = await sb.from("projects")
        .select("id,name,zoho_project_id,zoho_last_synced_at")
        .eq("id", localProjectId).in("record_type", ["ctc_file", "project"]).single();
      if (!proj || !proj.zoho_project_id) return json({ error: "This project isn't linked to a Zoho project." }, 400);

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
            zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
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
              zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
            }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String((local as any)[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "zoho_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}" — Zoho's edit was more recent; Zoho's value was kept.` });
            const moved = dueDateMovedLine(local.due_at, zt.due_at);
            if (moved) await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: moved, field: "due_at" });
          } else {
            const form = new URLSearchParams({
              name: local.title || "", description: local.description || "",
              priority: tmgPriorityToZoho(local.priority), status: tmgStatusToZoho(local.status),
            });
            const zd = isoToZohoDate(local.due_at); if (zd) form.set("end_date", zd);
            // Hand Zoho back the start date it already has, so writing the due
            // date can't make it invent one — see mapZohoTask's start_date note.
            if (zd && zt.start_date) form.set("start_date", zt.start_date);
            await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${proj.zoho_project_id}/tasks/${zt.id}/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
            await sb.from("tasks").update({ zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: Date.now() }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String((local as any)[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "tmg_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}" — TMG's edit was more recent; TMG's value was kept and pushed to Zoho.` });
          }
          conflicts++;
        } else {
          const moved = dueDateMovedLine(local.due_at, zt.due_at);
          await sb.from("tasks").update({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status,
            zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
            zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
          }).eq("id", local.id);
          if (moved) await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: moved, field: "due_at" });
          pulled++;
        }
      }

      await sb.from("projects").update({ zoho_last_synced_at: new Date().toISOString() }).eq("id", proj.id);
      return json({ ok: true, pulled, created, conflicts }, 200);
    }

    // Ops-only: one-time repair for tasks created BEFORE the 2026-09-11 fix
    // (this file's own header dates the change) — those pushed to Zoho with
    // no tasklist write-back and no owner. For every already-synced task in
    // one local project: re-fetch it from Zoho for the real tasklist_id/name,
    // then re-resolve and re-push person_responsible from TMG's own
    // assignee(s). Safe to re-run — every write here is idempotent.
    if (action === "backfill_zoho_links") {
      const projectId = (body.project_id || "").toString().trim();
      if (!projectId) return json({ error: "Missing project_id." }, 400);
      const { data: proj } = await sb.from("projects").select("id,zoho_project_id").eq("id", projectId).single();
      if (!proj || !proj.zoho_project_id) return json({ error: "Project isn't linked to Zoho." }, 400);

      const { data: rows } = await sb.from("tasks").select("id,zoho_task_id")
        .eq("project_id", projectId).not("zoho_task_id", "is", null);
      let fixed = 0, failed = 0;
      const detail: any[] = [];
      for (const t of (rows || [])) {
        const gr = await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${proj.zoho_project_id}/tasks/${t.zoho_task_id}/`, {});
        const gd = await gr.json().catch(() => ({}));
        const zt = gr.ok ? (gd.tasks || [])[0] : null;
        if (!zt) { failed++; detail.push({ task_id: t.id, error: gd?.error || "get_task failed" }); continue; }
        const m = mapZohoTask(zt);
        await sb.from("tasks").update({ zoho_tasklist_id: m.tasklist_id, zoho_tasklist_name: m.tasklist_name }).eq("id", t.id);

        const { data: assignees } = await sb.from("task_people").select("user_id").eq("task_id", t.id).eq("role", "assignee");
        let ownerSet = false;
        if (assignees && assignees.length) {
          const { data: profs } = await sb.from("profiles").select("email").in("id", assignees.map((a: any) => a.user_id));
          const emails = (profs || []).map((p: any) => p.email).filter(Boolean);
          if (emails.length) {
            const { ids, missing } = await resolveZohoOwnerIds(sb, conn, accessToken, portalBase, emails);
            if (ids.length) {
              const form = new URLSearchParams({ person_responsible: ids.join(",") });
              await zohoFetch(sb, conn, accessToken, `${portalBase}/projects/${proj.zoho_project_id}/tasks/${t.zoho_task_id}/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
              ownerSet = true;
            }
            if (missing.length) detail.push({ task_id: t.id, unresolved_emails: missing });
          }
        }
        fixed++;
        detail.push({ task_id: t.id, tasklist_name: m.tasklist_name, owner_set: ownerSet });
      }
      return json({ ok: true, fixed, failed, total: (rows || []).length, detail }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

// Normalizes a raw Zoho task record down to exactly the fields TMG syncs
// (plan §2.1) — nothing else from Zoho's task object is ever surfaced.
// tasklist_id/name are the one exception: display-only grouping (e.g.
// "Pre-List", "Clear to Close"), not part of the narrow field-sync scope,
// but they ride along on every task object already so no extra API call.
// A due date moving is the one change the team most wants a paper trail for
// ("how many times did this closing slip, and when?"), and most of those edits
// are made in Zoho's own UI, not in TMG — where the pull loop below used to
// overwrite due_at silently. Phrased the same way TaskDB.update phrases an
// in-app edit so both land in one readable timeline on the task.
function dueDateMovedLine(oldIso: string | null, newIso: string | null): string | null {
  if ((oldIso || null) === (newIso || null)) return null;
  const fmt = (iso: string | null) => {
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null
      // America/Chicago, not UTC: this line has to read the same as the due
      // date printed on the task row, and TMG is a Central-time brokerage
      // (accountability_weeks buckets on 'America/Chicago' for the same reason).
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  };
  const a = fmt(oldIso), b = fmt(newIso);
  if (!a && b) return `Due date set to ${b} — changed in Zoho Projects`;
  if (a && !b) return `Due date cleared (was ${a}) — changed in Zoho Projects`;
  if (a && b) return `Due date moved from ${a} to ${b} — changed in Zoho Projects`;
  return null;
}

function mapZohoTask(t: any) {
  return {
    id: t.id_string || String(t.id),
    title: t.name || "",
    description: t.description || null,
    due_at: zohoDateToIso(t.end_date),
    // Kept in Zoho's own MM-DD-YYYY form, and never written to TMG — it exists
    // only to be handed straight back to Zoho on an end_date write. Zoho's
    // Update Task API documents start_date as a companion parameter of
    // end_date, and a task with no start date gets one invented for it (the
    // due date itself), which reads as a false one-day task. Re-sending the
    // start date Zoho already has keeps it where the team put it.
    start_date: t.start_date || null,
    priority: zohoPriorityToTmg(t.priority),
    status: zohoStatusToTmg(t.status?.name || t.status),
    last_modified_time: t.last_modified_time_long != null ? Number(t.last_modified_time_long) : null,
    tasklist_id: t.tasklist?.id_string || (t.tasklist?.id != null ? String(t.tasklist.id) : null),
    tasklist_name: t.tasklist?.name ? String(t.tasklist.name).trim() : null,
  };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
