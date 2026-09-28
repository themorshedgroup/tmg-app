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

// ── Zoho task owners to TMG profiles ──────────────────────────────────────
// accountability_weeks counts a person's work strictly through task_people
// (it joins role = 'assignee'), so a task pulled in with nobody on it is not
// merely unattributed, it is invisible to the dashboard. Mirrors the poll
// function's ownerResolver; keep the two in step. Memoised per request,
// because both rosters behind it are the same for every task in the pull.
function ownerResolver(sb: any, conn: any, accessToken: string, portalBase: string) {
  let people: any[] | null = null;
  let emailForZohoId: Record<string, string> | null = null;

  const loadPeople = async () => {
    if (!people) {
      const { data } = await sb.from("profiles").select("id,email,first_name,status");
      people = (data || []).filter((p: any) => !p.status || p.status === "active");
    }
    return people!;
  };
  // The inverse of the email -> id cache resolveZohoOwnerIds already keeps on
  // zoho_projects_connection: the push knows a TMG email and needs Zoho's id,
  // the pull gets Zoho's id off a task and needs the email. One cache serves
  // both, so reading owners costs no extra /users/ call.
  const loadPortalIds = async () => {
    if (!emailForZohoId) {
      emailForZohoId = {};
      let cache = (conn.portal_users_cache || {}) as Record<string, string>;
      if (!Object.keys(cache).length) {
        const r = await zohoFetch(sb, conn, accessToken, `${portalBase}/users/`, {});
        const d = await r.json().catch(() => ({}));
        if (r.ok) {
          const fresh: Record<string, string> = {};
          for (const u of (d.users || d.userlist || [])) {
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
      for (const [email, id] of Object.entries(cache)) emailForZohoId[id] = email;
    }
    return emailForZohoId!;
  };

  // Returns the TMG profile ids AND whether every Zoho owner was placed. The
  // caller needs that second answer before it removes anybody: an owner this
  // code cannot place (Luciana holds a Zoho tasklist and has no profiles row)
  // must never be read as "Zoho says this person is off the task".
  return async (owners: ZOwner[]): Promise<{ ids: string[]; complete: boolean }> => {
    if (!owners.length) return { ids: [], complete: false };
    const roster = await loadPeople();
    const ids = new Set<string>();
    let unplaced = 0;
    for (const o of owners) {
      let email = o.email;
      if (!email && o.id) email = (await loadPortalIds())[o.id] || "";
      let hit = email
        ? roster.find((p: any) => String(p.email || "").toLowerCase().trim() === email)
        : null;
      if (!hit && o.name) {
        // Only an unambiguous single hit counts: filing one person's work
        // under another is worse than filing it under nobody.
        const w = leadWord(o.name);
        const hits = roster.filter((p: any) => leadWordHit(w, leadWord(p.first_name || p.email)));
        if (hits.length === 1) hit = hits[0];
      }
      if (hit) ids.add(hit.id); else unplaced++;
    }
    return { ids: Array.from(ids), complete: unplaced === 0 };
  };
}

// Upsert, never delete-then-insert: assigned_at is the column
// accountability_weeks buckets the "assigned" count by, so re-inserting a row
// that already exists would re-date somebody's whole history into this week.
//
// Adding is eager and removing is not. The Zoho owner field is read through a
// list of candidate names (see zohoOwners) and none of them is confirmed
// against the live portal, so the two guesses cost very different things: a
// wrong ADD leaves one name too many, which anybody can see and undo, while a
// wrong REMOVE erases the only record that a person held the work and the
// dashboard stops counting it. removalEpochMs is the higher bar, and it is
// Zoho's own modified time, passed only when it is a real clock reading rather
// than the content fingerprint, on a task TMG has stamped before. A person
// then comes off only if that Zoho edit is newer than the moment they were put
// on here. Kept identical to the poll function's copy.
async function applyAssignees(
  sb: any, taskId: string, createdAt: string | null, ids: string[], complete: boolean,
  removalEpochMs: number | null = null,
) {
  if (!ids.length) return;
  await sb.from("task_people").upsert(
    ids.map((user_id) => ({
      task_id: taskId, user_id, role: "assignee",
      assigned_at: createdAt || new Date().toISOString(),
    })),
    { onConflict: "task_id,user_id,role", ignoreDuplicates: true },
  );
  // A lookup miss is still not a statement that somebody was removed.
  if (!complete || removalEpochMs == null) return;
  const { data: existing } = await sb.from("task_people")
    .select("user_id,assigned_at").eq("task_id", taskId).eq("role", "assignee");
  const stale = (existing || []).filter((r: any) => {
    if (ids.includes(r.user_id)) return false;
    // No assignment date is no basis either: it would read as the epoch, which
    // makes every Zoho edit look newer and takes the row off on sight.
    const at = r.assigned_at ? new Date(r.assigned_at).getTime() : NaN;
    return !isNaN(at) && removalEpochMs > at + CLOCK_SKEW_MS;
  });
  if (!stale.length) return;
  const userIds = stale.map((r: any) => r.user_id);
  await sb.from("task_people").delete()
    .eq("task_id", taskId).eq("role", "assignee").in("user_id", userIds);
  // Every other change this sync makes leaves a line on the task. A removed
  // assignee left none, so the one person who needed to know had no way to
  // find out. Named, so it can be put back.
  const { data: who } = await sb.from("profiles").select("id,first_name,email").in("id", userIds);
  const names = (who || []).map((p: any) => p.first_name || p.email).filter(Boolean);
  await sb.from("task_activity").insert({
    task_id: taskId, kind: "system",
    content: names.length
      ? `Taken off this task in Zoho Projects: ${names.join(", ")}. Zoho is where that came from, so put them back there if it is wrong.`
      : "An assignee was taken off this task in Zoho Projects.",
  });
}

// Does this task already have somebody on it here? One narrow read, asked only
// on the path that is about to guess an owner from a tasklist NAME, so a
// project filed by phase and a task Zoho named an owner for never pay for it.
async function hasAssignee(sb: any, taskId: string): Promise<boolean> {
  const { data } = await sb.from("task_people")
    .select("user_id").eq("task_id", taskId).eq("role", "assignee").limit(1);
  return !!(data && data.length);
}

// Zoho pages the tasks endpoint and says nothing about there being more, so a
// full page is the only hint that there is one. Reading page one only is why
// 23 of the 30 linked projects sit at exactly 100 local tasks and none sits
// above it: every one has been silently losing its tail.
const TASK_PAGE = 200;
async function fetchProjectTasksPaged(
  doFetch: (url: string) => Promise<Response>,
  portalBase: string, zohoProjectId: string, sinceMs: number | null, maxPages: number,
): Promise<{ tasks: any[]; error: any; truncated: boolean }> {
  const all: any[] = [];
  let index = 1;
  for (let page = 0; page < maxPages; page++) {
    const u = new URL(`${portalBase}/projects/${zohoProjectId}/tasks/`);
    if (sinceMs != null) u.searchParams.set("last_modified_time", String(sinceMs));
    u.searchParams.set("index", String(index));
    u.searchParams.set("range", String(TASK_PAGE));
    const r = await doFetch(u.toString());
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return { tasks: all, error: d?.error || `HTTP ${r.status}`, truncated: false };
    const batch = (d.tasks || []) as any[];
    all.push(...batch);
    if (batch.length < TASK_PAGE) return { tasks: all, error: null, truncated: false };
    index += TASK_PAGE;
  }
  // Out of pages with a full page behind us, so the tail of this project was
  // never read. The caller must not move its cursor past what it did not see:
  // that is the same class of mistake as the ISO-string cursor that deadlocked
  // the poll, and the poll already guards it the same way.
  return { tasks: all, error: null, truncated: true };
}

// See the poll function's note: the insert that creates a task stamps
// zoho_last_synced_at from JS milliseconds before Postgres evaluates now() for
// updated_at, so 2804 rows read as locally edited when nobody touched them.
const CLOCK_SKEW_MS = 2000;
// The conflict branch can write to Zoho once per task and nothing used to cap
// it, so a catch-up over a long-stalled project must not fire them all at once.
const MAX_CONFLICT_PUSH_PER_SYNC = 20;

// ── Date conversion: TMG uses ISO timestamptz, Zoho Projects uses MM-DD-YYYY ──
// The brokerage's own zone, and the only zone any of this is read through:
// accountability_weeks buckets on it, and the app reads due_at through it too.
// Named once rather than written into each call, so the two copies of this
// file cannot drift apart on the one thing that decides what day a task is due.
const TMG_TZ = "America/Chicago";
// Deno runs in UTC, so Date's own getters cannot answer a question about
// Chicago, and Intl is the only thing here that knows when the clocks move.
function zoneParts(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  // en-US with hour12:false spells midnight as hour 24, so fold it back to 0.
  return { year: g("year"), month: g("month"), day: g("day"), hour: g("hour") % 24, minute: g("minute"), second: g("second") };
}
// How far the zone sits from UTC at that instant, DST included: read the
// instant as wall clock there, then treat that reading as if it were UTC. The
// gap between the two is the offset.
function zoneOffsetMs(ms: number, tz: string): number {
  const w = zoneParts(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms;
}
// Midnight on a calendar date IN that zone, as the UTC instant it really is.
// Two passes because the offset that applies is the one at the answer, not the
// one at the first guess, and those two differ on the days the clocks move.
function zoneMidnightMs(y: number, m: number, d: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d);
  return naive - zoneOffsetMs(naive - zoneOffsetMs(naive, tz), tz);
}
// A Zoho end_date is a CALENDAR DATE with no time of day, so the only thing
// that matters is what day it reads back as. Midnight UTC was the wrong answer
// to that: the app and accountability_weeks both read due_at through
// America/Chicago, where midnight UTC lands in the evening of the day BEFORE,
// so all 1402 dated rows this pull had written were stored, shown and scored a
// day early. Midnight in this zone is the same instant the app itself stores
// for a date typed with no time (src/tasks.jsx builds "YYYY-MM-DDT00:00" and
// lets the browser resolve it), so a Zoho-sourced date and a TMG-sourced date
// are now the same kind of value and behave the same way in the same view.
function zohoDateToIso(mmddyyyy: string | null | undefined): string | null {
  if (!mmddyyyy) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(mmddyyyy.trim()); if (!m) return null;
  const ms = zoneMidnightMs(Number(m[3]), Number(m[1]), Number(m[2]), TMG_TZ);
  return isNaN(ms) ? null : new Date(ms).toISOString();
}
// The other half of the round trip, so it has to read the day in the SAME zone
// or a date pulled out of Zoho would go back into Zoho a day earlier than it
// came. Reading it in UTC is also what sent a task due at 7pm here to Zoho as
// the following day.
// A bare "YYYY-MM-DD" is already a calendar date and goes straight through:
// zoho-projects pushes project dates in that form, straight off the date
// columns projects.started_at/target_date, and putting a zone anywhere near a
// value that has no time of day is how it would move by a day.
function isoToZohoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (bare) return `${bare[2]}-${bare[3]}-${bare[1]}`;
  const ms = Date.parse(String(iso)); if (isNaN(ms)) return null;
  const w = zoneParts(ms, TMG_TZ);
  return `${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}-${w.year}`;
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

    // ── List tasks in a project. `since` is an ISO timestamp from the caller
    // and Zoho's filter is last_modified_time, which it validates by NAME and
    // then wants as epoch milliseconds: handing it the ISO string got a 403
    // "Data type mismatch" on every call. Converted here rather than at the
    // caller, because the ISO string is this action's published contract and
    // tasks.jsx passes one. An unparseable value is dropped instead of sent,
    // since an unfiltered list is merely wasteful while a 403 returns nothing
    // at all. ──
    if (action === "list_tasks") {
      const projectId = (body.project_id || "").toString().trim();
      if (!projectId) return json({ error: "Missing project_id." }, 400);
      const u = new URL(`${portalBase}/projects/${projectId}/tasks/`);
      const sinceMs = body.since ? Date.parse(String(body.since)) : NaN;
      if (!isNaN(sinceMs)) u.searchParams.set("last_modified_time", String(sinceMs));
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

      // An incremental cursor is only honest once TMG actually holds Zoho's
      // state, and no pull had ever written an owner, a completion date, or a
      // readable modified timestamp, so every row imported before this change
      // is a shell. A project with any task still missing its Zoho timestamp
      // is therefore read in full, and drops back to the cheap incremental
      // read by itself once the last shell is filled.
      const { data: shell } = await sb.from("tasks").select("id")
        .eq("project_id", proj.id).not("zoho_task_id", "is", null)
        .is("zoho_last_modified_time", null).limit(1);
      const fullRead = !proj.zoho_last_synced_at || !!shell?.length;
      // Epoch milliseconds, not the ISO string: see the list_tasks note above.
      // Sending the timestamptz straight through is what made every poll since
      // 2026-09-07 return 403 and pull nothing.
      const sinceRaw = fullRead ? NaN : Date.parse(proj.zoho_last_synced_at);
      const paged = await fetchProjectTasksPaged(
        (url) => zohoFetch(sb, conn, accessToken, url, {}),
        portalBase, proj.zoho_project_id, isNaN(sinceRaw) ? null : sinceRaw, 25,
      );
      if (paged.error) return json({ error: paged.error }, 502);

      const zTasks = paged.tasks.map(mapZohoTask);
      const resolveOwners = ownerResolver(sb, conn, accessToken, portalBase);
      let pulled = 0, conflicts = 0, created = 0, conflictPushes = 0, conflictDeferred = 0, unverified = 0;
      let conflictRowsRejected = 0, conflictRejectWhy = "";

      // The active team, read once for this sync. Two callers want it two
      // ways: the per-person test asks which names hold a list, the fallback
      // below needs the profile behind the name it matched.
      let roster: { id: string; name: string }[] | null = null;
      const loadRoster = async (): Promise<{ id: string; name: string }[]> => {
        if (roster) return roster;
        const { data: team } = await sb.from("profiles").select("id,first_name,email,status");
        roster = (team || [])
          .filter((p: any) => !p.status || p.status === "active")
          .map((p: any) => ({
            id: p.id,
            name: String(p.first_name || "").trim() || String(p.email || "").split("@")[0],
          }))
          .filter((p: any) => p.name);
        return roster;
      };
      // Zoho's owner field is a guess (see zohoOwners), and when it answers
      // nobody the tasklist the task sits in is the second source this project
      // already trusts: Accountabilities files one list per person, which is
      // how 20260924140000 recovered 18 assignees with no Zoho owner at all.
      // Read at most once per sync, and only for a project whose lists are
      // named after PEOPLE: a CTC file's lists are deal phases and matching
      // those would invent owners rather than recover them.
      let tasklists: ZTasklist[] | null = null;
      let tasklistsRead = false;
      let perPerson = false;
      const ownerFromTasklist = async (tasklistName: string | null): Promise<string[]> => {
        if (!tasklistName) return [];
        // The name test first and the Zoho read second, so a phase-named
        // project answers here and never spends a call against the
        // 100-per-2-min ceiling. An ambiguous name settles here too, as nobody.
        const id = profileForTasklistName(tasklistName, await loadRoster());
        if (!id) return [];
        if (!tasklistsRead) {
          tasklistsRead = true;
          tasklists = await fetchProjectTasklists(
            (url) => zohoFetch(sb, conn, accessToken, url, {}), portalBase, proj.zoho_project_id);
          if (tasklists) {
            perPerson = distinctPeopleWithLists(
              tasklists, (await loadRoster()).map((r) => r.name)) >= 2;
          }
        }
        return tasklists && perPerson ? [id] : [];
      };

      for (const zt of zTasks) {
        const { data: local } = await sb.from("tasks").select("*")
          .eq("project_id", proj.id).eq("zoho_task_id", zt.id).maybeSingle();

        const owned = await resolveOwners(zt.owners);
        // Nobody came back from Zoho's owner field, so ask the tasklist. A
        // list name is a RECOVERY for a task nobody owns, never a correction
        // of an assignment a person made here. "Resolve TMG Duplicate Client
        // Folders" is assigned to Alexandra and sits in the "Tarek" list only
        // because of the default-tasklist bug the push path now fixes, so
        // reading the list name there would put Tarek on the task ALONGSIDE
        // her and accountability_weeks would credit the work to both. It would
        // recur every time somebody reassigns a task here without also moving
        // the Zoho list. The one-time backfill (20260924140000) carries this
        // same guard; this is the permanent version of it. A name off Zoho's
        // own owner field is a different claim and keeps its behaviour.
        let assigneeIds = owned.ids;
        if (!assigneeIds.length) {
          const fromList = await ownerFromTasklist(zt.tasklist_name);
          // The read only happens once the list has actually named somebody,
          // and a row about to be inserted trivially has nobody on it yet.
          if (fromList.length && (!local || !(await hasAssignee(sb, local.id)))) {
            assigneeIds = fromList;
          }
        }
        // A fingerprint is not a clock (see MIN_REAL_EPOCH_MS), and only a
        // clock can support the claim that somebody was taken off a task.
        const zohoEpochMs = (zt.last_modified_time || 0) >= MIN_REAL_EPOCH_MS ? zt.last_modified_time : null;

        if (!local) {
          const { data: inserted } = await sb.from("tasks").insert({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status, project_id: proj.id,
            completed_at: completionFor(zt, null),
            zoho_task_id: zt.id, zoho_last_synced_at: new Date().toISOString(),
            zoho_last_modified_time: zt.last_modified_time,
            zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
          }).select().single();
          if (inserted) {
            // No removalEpochMs: a row created a line ago has nobody on it yet.
            await applyAssignees(sb, inserted.id, inserted.created_at, assigneeIds, owned.complete);
            await sb.from("task_activity").insert({ task_id: inserted.id, kind: "system", content: "Task created in Zoho Projects" });
            created++;
          }
          continue;
        }

        // A stored null does not mean the two sides agree, it means TMG has
        // never held a Zoho timestamp for this task: null !== null is false,
        // so the old test read every imported row as unchanged and skipped it
        // forever. Treat no-stored-timestamp as CHANGED, which costs one extra
        // update the first time and then settles.
        const neverStamped = local.zoho_last_modified_time == null;

        // Applied on every pass, ahead of the change test rather than inside
        // it: ownership was never written before this change, so the rows that
        // need an assignee most are the ones Zoho has nothing new to say about.
        await applyAssignees(
          sb, local.id, local.created_at, assigneeIds, owned.complete,
          neverStamped ? null : zohoEpochMs,
        );

        const localChangedSinceSync = local.updated_at && local.zoho_last_synced_at
          ? new Date(local.updated_at).getTime() > new Date(local.zoho_last_synced_at).getTime() + CLOCK_SKEW_MS
          : !local.zoho_last_synced_at;
        const zohoChangedSinceSync = neverStamped || zt.last_modified_time !== local.zoho_last_modified_time;
        if (!zohoChangedSinceSync) continue;

        // With no stored Zoho timestamp there is no basis for the claim that
        // TMG is the newer side, and the conflict branch answers that claim by
        // POSTing TMG's values over Zoho's, which on a stalled project means
        // pushing weeks-old status back and reopening finished tasks. Holding
        // the catch-up to Zoho-wins makes it read-only by construction.
        // A fingerprint is not a clock: comparing one against updated_at
        // would hand TMG every conflict and push its values over Zoho's. With
        // no provable recency, the read-only branch is the honest answer.
        const provableTime = zohoEpochMs != null;
        if (localChangedSinceSync && !neverStamped && provableTime) {
          const localMs = local.updated_at ? new Date(local.updated_at).getTime() : 0;
          const zohoMs = zt.last_modified_time || 0;
          const changedField = overwrittenFields(local, zt)[0] || "title";
          if (zohoMs > localMs) {
            await sb.from("tasks").update({
              title: zt.title, description: zt.description, due_at: zt.due_at,
              priority: zt.priority, status: zt.status,
              completed_at: completionFor(zt, local),
              zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
              zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
            }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String((local as any)[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "zoho_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}": Zoho's edit was more recent, so Zoho's value was kept.` });
            const moved = dueDateMovedLine(local.due_at, zt.due_at);
            if (moved) await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: moved, field: "due_at" });
          } else if (conflictPushes >= MAX_CONFLICT_PUSH_PER_SYNC) {
            // Over the ceiling on conflict write-backs for one sync. Left
            // untouched, sync stamps included, so the next run resolves it.
            conflictDeferred++;
            continue;
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
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}": TMG's edit was more recent, so TMG's value was kept and pushed to Zoho.` });
            conflictPushes++;
          }
          conflicts++;
        } else {
          // localChangedSinceSync here means both sides moved and the branch
          // above could not prove which moved last, so the update below is
          // about to replace a real TMG edit. Zoho winning is the policy and
          // is not what changes; what changes is that the loss stops being
          // invisible. Read off the local row before the update overwrites it.
          const overwritten = localChangedSinceSync ? overwrittenFields(local, zt) : [];
          const moved = dueDateMovedLine(local.due_at, zt.due_at);
          await sb.from("tasks").update({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status,
            completed_at: completionFor(zt, local),
            zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
            zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
          }).eq("id", local.id);
          if (overwritten.length) {
            // The task line goes first because it is the one a person reads
            // and it depends on nothing. The conflict row needs the widened
            // resolution check from 20260924140000 and is refused by Postgres
            // until that migration lands, which must not cost the line.
            await sb.from("task_activity").insert({
              task_id: local.id, kind: "system", field: overwritten[0],
              content: unverifiedOverwriteLine(local, zt, overwritten, neverStamped),
            });
            // Counted only when the row actually lands. The live CHECK on
            // resolution still allows two values and 20260924140000 is what
            // widens it, so a deploy that lands before that migration has
            // Postgres refusing every one of these inserts. supabase-js hands
            // a refusal back as { error } instead of throwing, so the old
            // count reported overwrites_unverified with not one row behind it
            // for anybody to go and look at.
            const { error: conflictErr } = await sb.from("zoho_sync_conflicts").insert({
              task_id: local.id, project_id: proj.id, field: overwritten[0],
              tmg_value: String((local as any)[overwritten[0]] ?? ""),
              zoho_value: String((zt as any)[overwritten[0]] ?? ""),
              resolution: "zoho_won_unverified",
            });
            if (conflictErr) {
              conflictRowsRejected++;
              // Said once per sync, with the reason, so a refused write is
              // something a person can find rather than a silent shortfall.
              if (!conflictRejectWhy) {
                conflictRejectWhy = String((conflictErr as any).message || conflictErr);
                console.warn(JSON.stringify({ zoho_projects_sync_now_conflict_row_rejected: { project: proj.name, why: conflictRejectWhy } }));
              }
            } else {
              unverified++;
            }
          }
          if (moved) await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: moved, field: "due_at" });
          pulled++;
        }
      }

      // This stamp IS the incremental cursor. Moving it past a tail the paged
      // read never reached would skip those tasks for good, so a truncated
      // read leaves the cursor where it was and the next sync reads again.
      if (!paged.truncated) {
        await sb.from("projects").update({ zoho_last_synced_at: new Date().toISOString() }).eq("id", proj.id);
      }
      return json({
        ok: true, pulled, created, conflicts, conflicts_deferred: conflictDeferred,
        ...(unverified > 0 ? { overwrites_unverified: unverified } : {}),
        ...(conflictRowsRejected > 0 ? { conflict_rows_rejected: conflictRowsRejected, conflict_rows_rejected_why: conflictRejectWhy } : {}),
        ...(paged.truncated ? { pull_truncated: "more tasks than this sync could read, run it again" } : {}),
      }, 200);
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
// Two sides spell the same moment differently, so text comparison is the
// wrong question to ask of a date. PostgREST renders a stored timestamptz as
// "2026-09-14T05:00:00+00:00" and zohoDateToIso hands back
// "2026-09-14T05:00:00.000Z": not equal as strings, the same instant in fact.
// Comparing them as strings read every dated task as changed, which on the
// first catch-up run would have written "Due date moved from Sep 14 to Sep 14"
// onto 1402 of the 1408 dated tasks, in the history a person reads. Only 6 of
// them carry a real time of day, so only 6 could have moved at all.
function sameMoment(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v == null || v === "";
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  const x = Date.parse(String(a)), y = Date.parse(String(b));
  // Unparseable on either side is not a moment, so fall back to the text.
  return isNaN(x) || isNaN(y) ? String(a) === String(b) : x === y;
}
// Two different things reach this function and only one of them is a moment.
// Midnight UTC is how a Zoho calendar date was spelled BEFORE zohoDateToIso
// was corrected above, and 1402 stored rows still hold that spelling until the
// catch-up run rewrites them. Read through America/Chicago those land five
// hours back in the day before, so printing them in UTC is what says the day
// Zoho actually means. Everything else here is a real moment and wants the
// brokerage's own zone (accountability_weeks buckets on 'America/Chicago' for
// the same reason), which is also where a corrected Zoho date now belongs:
// this zone's midnight is never exactly midnight UTC, so the two cannot be
// mistaken for each other.
// This branch is what keeps the first catch-up run silent. It reads the old
// spelling and the new one and gets the same day out of both, so
// dueDateMovedLine has nothing to report on any of the 1402 rows whose stored
// value it is about to correct, and the fabricated "Due date moved from Sep 14
// to Sep 14" lines the last pass drove to zero stay at zero.
// The cost is a TMG task set to exactly 6pm here in winter (7pm in summer),
// which IS midnight UTC and gets read as a calendar date, printing that one
// label a day late. That was already true before this change. Once the poll
// has rewritten the 1402 rows, nothing in the table is midnight UTC except
// such a task, and this branch can be deleted outright.
function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const calendarDate = d.getTime() % 86400000 === 0;
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    timeZone: calendarDate ? "UTC" : "America/Chicago",
  });
}
function dueDateMovedLine(oldIso: string | null, newIso: string | null): string | null {
  if (sameMoment(oldIso, newIso)) return null;
  const a = shortDate(oldIso), b = shortDate(newIso);
  // Both ends print the same day, so the line has nothing left to say: it
  // speaks in days only, and Zoho's end_date cannot carry a time of day at
  // all, so the 6 dated tasks here that do carry one lose it to the pull and
  // would each read "Due date moved from Sep 14 to Sep 14" once. A within-day
  // move is not something this line could ever report, so nothing is lost.
  if (a && b && a === b) return null;
  if (!a && b) return `Due date set to ${b} (changed in Zoho Projects)`;
  if (a && !b) return `Due date cleared (was ${a}), changed in Zoho Projects`;
  if (a && b) return `Due date moved from ${a} to ${b} (changed in Zoho Projects)`;
  return null;
}

// ── Recording an overwrite this sync cannot justify ───────────────────────
// The plain-pull branch takes Zoho's values whenever it cannot prove TMG's are
// newer. Zoho winning stays the policy; what was missing is any trace of it, so
// an edit made here and replaced minutes later left no conflict row and no line
// on the task. Kept identical to the poll function's copy.
const SYNCED_FIELDS = ["title", "description", "due_at", "priority", "status"];
const FIELD_LABEL: Record<string, string> = {
  title: "Title", description: "Description", due_at: "Due date",
  priority: "Priority", status: "Status",
};
// Short on purpose: a description runs to thousands of characters, and this
// line is meant to be read on the task, not scrolled through.
function shortValue(field: string, v: unknown): string {
  if (v == null || v === "") return "(empty)";
  if (field === "due_at") return shortDate(String(v)) || String(v);
  const str = String(v);
  return str.length > 120 ? str.slice(0, 117) + "..." : str;
}
// due_at is the one synced field that holds a MOMENT rather than text, and the
// two sides spell the same moment differently (see sameMoment), so comparing
// it as text reported an overwrite on every dated task that had not changed.
// The other four are plain text on both sides, where text comparison is right.
function overwrittenFields(local: any, zt: any): string[] {
  return SYNCED_FIELDS.filter((f) => f === "due_at"
    ? !sameMoment(local[f], zt[f])
    : (local[f] || null) !== (zt[f] || null));
}
function unverifiedOverwriteLine(local: any, zt: any, fields: string[], neverStamped: boolean): string {
  const why = neverStamped
    ? "TMG has never held a modified time for this task"
    : "Zoho sent no modified time for this task";
  const f = fields[0];
  const rest = fields.slice(1).map((x) => FIELD_LABEL[x].toLowerCase());
  return `Edited here and in Zoho Projects since the last sync, and ${why}, so there is no telling which edit came last. Zoho's version was kept. ${FIELD_LABEL[f]} was "${shortValue(f, local[f])}" here and is now "${shortValue(f, zt[f])}".`
    + (rest.length ? ` Also replaced: ${rest.join(", ")}.` : "");
}

// ── Three fields Zoho does not spell the way this file assumed ────────────
// Kept identical to zoho-projects-poll's copies by the self-contained-edge-
// function convention this file already follows. Each is read through a list
// of candidate names, because the portal cannot be queried from here and a
// field that reads null looks exactly like a task nobody has touched, which is
// how zoho_last_modified_time stayed null on all 2810 imported rows.

// The change cursor. Zoho's QUERY parameter is called last_modified_time, but
// the task object it returns carries no last_modified_time_long: 2803 rows
// took their tasklist id and name off the same payload in the same insert and
// not one got a timestamp, which is what an absent field looks like. The pair
// Zoho documents on a task is last_updated_time, so try that first and keep
// the old spelling behind it. Only ever compared, never shown.
function zohoModifiedMs(t: any): number | null {
  for (const v of [t.last_updated_time_long, t.last_modified_time_long]) {
    if (v != null && v !== "" && !isNaN(Number(v))) return Number(v);
  }
  for (const v of [t.last_updated_time, t.last_modified_time]) {
    if (v) { const ms = Date.parse(String(v)); if (!isNaN(ms)) return ms; }
  }
  return null;
}

// When Zoho answers to none of those names, fall back to a fingerprint of the
// fields this sync actually carries. It is not a time and never pretends to be
// one. It exists so the change detector can SETTLE: treating a missing
// timestamp as "changed" is the right fail-safe, but on its own it means every
// task reads as changed on every tick forever and the job never stops
// rewriting rows nobody edited. A fingerprint changes exactly when the synced
// content changes, which is the only question the detector actually asks.
function zohoFingerprint(t: any): number {
  const src = [t.name, t.description, t.end_date, t.start_date, t.priority,
    t.status?.name ?? t.status, t.completed_time, t.tasklist?.name]
    .map((v) => String(v ?? "")).join("\u0000");
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0; // stays far below any real epoch, so the two can be told apart
}
// Epoch milliseconds passed this in 2001, and a fingerprint is a 32-bit
// unsigned int, so it never can. Anything under it is a fingerprint, and a
// fingerprint must never be compared against a clock to decide who is newer.
const MIN_REAL_EPOCH_MS = 1e12;

// When the work was finished. accountability_weeks counts completions by the
// DATE in completed_at, not by status, so a task can read done on the task
// list and still score zero for the week.
function zohoCompletedIso(t: any): string | null {
  let ms: number | null = null;
  for (const v of [t.completed_time_long, t.closed_time_long]) {
    if (v != null && v !== "" && !isNaN(Number(v))) { ms = Number(v); break; }
  }
  if (ms == null) {
    for (const v of [t.completed_time, t.closed_time]) {
      if (v) { const p = Date.parse(String(v)); if (!isNaN(p)) { ms = p; break; } }
    }
  }
  return ms ? new Date(ms).toISOString() : null;
}

// Who Zoho says the task belongs to. Nested under details.owners on a
// list_tasks response, repeated at the top level by some endpoints, so read
// both. Email is the dependable join to a TMG profile but is not always on the
// payload, hence the id and then the name behind it.
type ZOwner = { id: string; name: string; email: string };
function zohoOwners(t: any): ZOwner[] {
  const raw = (t.details?.owners ?? t.owners ?? []) as any[];
  return raw
    .map((o) => ({
      id: o.id_string || (o.id != null ? String(o.id) : (o.zpuid != null ? String(o.zpuid) : "")),
      name: String(o.full_name || o.name || "").trim(),
      email: String(o.email || "").toLowerCase().trim(),
    }))
    .filter((o) => o.id || o.name || o.email);
}

// Zoho's own completion time whenever it gives one. When it does not, stamp
// now() only on the TRANSITION into done. Never stamp a task that arrives
// already finished: that is history, and dating it today would credit
// month-old work to this week. Cleared when Zoho reopens a task.
function completionFor(zt: any, local: any | null): string | null {
  if (zt.status !== "done") return null;
  if (zt.completed_at) return zt.completed_at;
  if (local?.completed_at) return local.completed_at;
  return local && local.status !== "done" ? new Date().toISOString() : null;
}

// Same leading-word rule as tasks.jsx's memberForTasklistName and the poll
// function's routing: a Zoho display name is freehand ("Gustavo ( Finance
// Controller & Bookkeeper)") and only its first word names anybody. Three
// letters is the floor because two would match half the team, and either side
// may be the short form of the other ("Alexa" / "Alexandra").
function leadWord(str: string | null | undefined): string {
  return (str || "").toLowerCase().replace(/[^a-z]+/g, " ").trim().split(" ")[0] || "";
}
function leadWordHit(a: string, b: string): boolean {
  return a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a));
}

// Whose list is this? Exactly one active profile, or nobody. Same answer to
// ambiguity that 20260924140000 gives: two possible people means nobody,
// because filing one person's work under another is worse than not filing it.
function profileForTasklistName(name: string | null, roster: { id: string; name: string }[]): string | null {
  const w = leadWord(name);
  if (w.length < 3) return null;
  const hits = roster.filter((p) => leadWordHit(w, leadWord(p.name)));
  return hits.length === 1 ? hits[0].id : null;
}

// ── Is this project filed by person, or by phase? ─────────────────────────
// An ordinary CTC file names its lists after the stages of a deal ("Pre-List",
// "Option Period", "Clear to Close"). "Accountabilities" names them after
// PEOPLE. The test is what the lists are NAMED, never how many there are, and
// the threshold is two DISTINCT people: one is not enough, because a phase name
// can hit a real first name by accident, and it counts people rather than
// matching lists because one person often keeps two ("Symon (O.M.)", "Symon
// 2"). Kept identical to the poll function's copy.
function distinctPeopleWithLists(lists: ZTasklist[], teamNames: string[]): number {
  const team = Array.from(new Set(teamNames.map(leadWord).filter((n) => n.length >= 3))).sort();
  const people = new Set<string>();
  for (const l of lists) {
    const w = leadWord(l.name);
    if (w.length < 3) continue;
    const who = team.find((m) => leadWordHit(w, m));
    if (who) people.add(who);
  }
  return people.size;
}

// The project's lists as Zoho has them, not as the already-synced rows imply:
// a list made for somebody this morning has no local rows yet, and that person
// is precisely the one whose work gets misfiled. Returns null (not []) when
// Zoho would not answer, so the caller can tell "no lists" from "we do not
// know yet". Same endpoint and response shape as the list_tasklists action.
type ZTasklist = { id: string; name: string };
async function fetchProjectTasklists(
  doFetch: (url: string) => Promise<Response>, portalBase: string, zohoProjectId: string,
): Promise<ZTasklist[] | null> {
  const r = await doFetch(`${portalBase}/projects/${zohoProjectId}/tasklists/`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return null;
  return ((d.tasklists || []) as any[])
    .map((t) => ({ id: t.id_string || (t.id != null ? String(t.id) : ""), name: t.name ? String(t.name).trim() : "" }))
    .filter((t) => t.id);
}

// ── Zoho's text is markup, not display text ───────────────────────────────
// Zoho hands back tasklist names HTML-ESCAPED, and this file stored what it
// was given: the portal's "Gustavo ( Finance Controller & Bookkeeper)" arrives
// as "... &amp; ..." and renders with the escape still in it everywhere TMG
// shows the name. Nothing downstream un-escapes it, so it has to happen here,
// or the backfill migration's repair is undone by the next poll five minutes
// later.
// The scope is narrow because it was checked against the live table rather
// than assumed. Tasklist names are escaped: the one name in the portal holding
// an ampersand holds it as "&amp;". Task titles are NOT: 275 of them hold a
// bare "&" and not one holds an entity. Descriptions must not be touched at
// all, because Zoho sends them as whole HTML documents (2163 of them contain
// tags), where "&amp;" is correct markup and decoding "&lt;" would turn text
// into tags.
const NAMED_ENTITIES: Record<string, string> = {
  "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
  // A non-breaking space is invisibly different from a space on screen and
  // silently breaks name matching, so it decodes to the plain one.
  "&nbsp;": " ",
};
// A number that is not a character is not an entity: hand back the literal
// text rather than throwing the whole pull over one badly typed list name.
function entityChar(n: number, raw: string): string {
  const ok = Number.isInteger(n) && n > 0 && n <= 0x10FFFF && (n < 0xD800 || n > 0xDFFF);
  return ok ? String.fromCodePoint(n) : raw;
}
// Ampersand is decoded LAST, or "&amp;lt;" would decode two steps in one pass
// and come out as "<". Same order, and for the same reason, as section 1 of
// the backfill migration.
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (raw, h) => entityChar(parseInt(h, 16), raw))
    .replace(/&#(\d+);/g, (raw, n) => entityChar(Number(n), raw))
    .replace(/&(?:lt|gt|quot|apos|nbsp);/g, (m) => NAMED_ENTITIES[m] ?? m)
    .replace(/&amp;/g, "&");
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
    last_modified_time: zohoModifiedMs(t) ?? zohoFingerprint(t),
    completed_at: zohoCompletedIso(t),
    owners: zohoOwners(t),
    tasklist_id: t.tasklist?.id_string || (t.tasklist?.id != null ? String(t.tasklist.id) : null),
    // decodeEntities, not raw: Zoho escapes this one field and TMG shows it.
    tasklist_name: t.tasklist?.name ? decodeEntities(String(t.tasklist.name)).trim() : null,
  };
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
