// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: zoho-crm
// Proxies Zoho CRM API calls server-side so OAuth secrets never reach the
// browser. Mirrors the google-calendar function's auth gate.
//
// Deploy: Supabase Dashboard → Edge Functions → new function `zoho-crm`
//   Paste this whole file, then click Deploy.
//
// Secrets required (Dashboard → Edge Functions → Manage secrets):
//   ZOHO_CLIENT_ID       = Zoho Self Client / Server-based app client id
//   ZOHO_CLIENT_SECRET   = that client's secret
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// The org's Zoho refresh token is stored in the `zoho_connection` table
// (one row, service-role only). The edge function reads it, exchanges for
// an access token, and proxies the CRM call.
//
// POST actions:
//   { action: 'create_agent_kpi', record }  → create one Agent_KPI record
//   { action: 'search_contacts', query }    → fuzzy-search contacts by name
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Service-role client (server-side only; bypasses RLS for token lookups).
function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key);
}

// Verifies the caller's Supabase session and requires an ACTIVE TMG profile.
async function authorizeCaller(req: Request) {
  const sb = serviceClient();
  if (!sb)
    return { ok: false as const, status: 500, error: "Server auth not configured." };

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token)
    return { ok: false as const, status: 401, error: "Sign in required." };

  // Server/ops caller: the service-role key itself (never present in browsers) acts as
  // an admin identity — used for the owner_diagnosis action and ops tooling.
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (svcKey && token === svcKey) {
    return { ok: true as const, userId: "service", sb, isService: true as const };
  }

  const {
    data: { user },
    error,
  } = await sb.auth.getUser(token);
  if (error || !user) {
    // Ops tooling, second door. The check further up compares the bearer token
    // to this function's own SUPABASE_SERVICE_ROLE_KEY, which only recognises
    // an ops caller while BOTH sides hold the same string -- and this project
    // has more than one valid secret key (the newer `sb_secret_…` format is
    // issued alongside the legacy JWT). A CLI holding a different-but-equally-
    // valid secret key was being told "invalid or expired session", which is
    // not what had happened.
    //
    // So ask Supabase what the token can DO rather than what it looks like.
    // listUsers is an Auth ADMIN call: anon and publishable keys are refused
    // by Supabase itself, and a signed-in user's JWT never reaches this line
    // (it resolves at getUser above). Passing it therefore means service-role,
    // which is the same privilege the string match was already granting -- no
    // new access, just a second spelling of the same key.
    try {
      const probe = createClient(Deno.env.get("SUPABASE_URL") || "", token);
      const { error: probeErr } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
      if (!probeErr) return { ok: true as const, userId: "service", sb, isService: true as const };
    } catch { /* not a service key -- fall through to the 401 below */ }
    return { ok: false as const, status: 401, error: "Invalid or expired session." };
  }

  const { data: profile, error: pErr } = await sb
    .from("profiles")
    .select("status, access")
    .eq("id", user.id)
    .single();
  if (pErr || !profile)
    return { ok: false as const, status: 403, error: "Account pending approval." };
  if (profile.status !== "active")
    return { ok: false as const, status: 403, error: "Account is not active." };

  // profiles.access is a text[] of roles; admin/operations are the elevated
  // ones (same rule the app uses). Needed so an admin can file a health goal on
  // someone else's behalf while everyone else stays limited to their own.
  const roles: string[] = Array.isArray(profile.access)
    ? profile.access.map((r: any) => String(r).toLowerCase())
    : String(profile.access || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
  const isAdmin = roles.some((r) => r === "admin" || r === "operations");

  return { ok: true as const, userId: user.id, sb, isAdmin };
}

// ── Zoho OAuth: refresh token → access token ──────────────────────────
// The org connection row stores: refresh_token, api_domain (e.g. "www.zohoapis.com"),
// plus a CACHED access_token + access_token_expires_at so we don't mint a new token
// on every call (Zoho rate-limits the token endpoint with `access_denied` if you do).

// Low-level: exchange the refresh token for a fresh access token (1-hour life).
// Returns the token AND when it expires so the caller can cache it.
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
    // When too many tokens are requested too fast, Zoho's token endpoint
    // replies { error: "Access Denied", error_description: "You have made too
    // many requests continuously..." }. Detect it case-insensitively (and via
    // the description) so the UI can say "wait a moment" instead of implying a
    // real permission problem.
    const err = String(data.error || "").toLowerCase();
    const desc = String(data.error_description || "").toLowerCase();
    if (err === "access denied" || err === "access_denied" || desc.includes("too many requests"))
      throw new Error("Zoho is rate-limiting token requests right now (too many in a short time). Wait a minute and try again.");
    throw new Error(data.error_description || data.error || "Failed to refresh Zoho token");
  }
  const expiresIn = Number(data.expires_in) || 3600; // seconds
  return {
    access_token: data.access_token,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

// High-level: return a usable access token, reusing the cached one until it's
// within 5 minutes of expiry. Only then do we mint a new one and persist it.
// This collapses dozens of token mints per minute down to ~one per hour, which
// is what keeps Zoho from returning `access_denied`.
async function getZohoToken(sb: any, conn: any): Promise<string> {
  const BUFFER_MS = 5 * 60 * 1000; // refresh 5 min early
  const exp = conn.access_token_expires_at ? Date.parse(conn.access_token_expires_at) : 0;
  if (conn.access_token && exp && exp - Date.now() > BUFFER_MS) {
    return conn.access_token; // cached token still good
  }
  const minted = await mintZohoToken(conn.refresh_token, conn.accounts_url || "https://accounts.zoho.com");
  // Persist for the NEXT invocation (best-effort — never block the request on it).
  try {
    await sb
      .from("zoho_connection")
      .update({ access_token: minted.access_token, access_token_expires_at: minted.expires_at })
      .eq("refresh_token", conn.refresh_token);
  } catch (_) { /* cache write is best-effort */ }
  // Reuse within this same invocation too.
  conn.access_token = minted.access_token;
  conn.access_token_expires_at = minted.expires_at;
  return minted.access_token;
}

// Invalidate the cached token and mint a fresh one — collapsing every caller
// within THIS invocation into a single remint via conn._remintPromise. That
// matters for the batched actions (spouse_links / tasks_for_contacts) which
// fire many parallel requests on one token: if that token is stale they'd all
// 401 at once, and without this guard each would mint its own token and re-trip
// Zoho's rate limit (the very thing we're fixing).
async function invalidateAndRemint(sb: any, conn: any): Promise<string> {
  if (!conn._remintPromise) {
    conn._remintPromise = (async () => {
      conn.access_token = null;
      conn.access_token_expires_at = null;
      try {
        await sb
          .from("zoho_connection")
          .update({ access_token: null, access_token_expires_at: null })
          .eq("refresh_token", conn.refresh_token);
      } catch (_) { /* best-effort */ }
      return await getZohoToken(sb, conn);
    })().catch((e: any) => {
      // If the remint failed (e.g. Zoho rate-limited the mint), clear the cached
      // promise so a later 401 in this same invocation can retry from scratch
      // instead of replaying the failure. In-flight awaiters still see the error.
      conn._remintPromise = null;
      throw e;
    });
  }
  return conn._remintPromise;
}

// Make a Zoho CRM request with the given token. If Zoho rejects it with HTTP 401
// (e.g. the cached token was revoked before its natural expiry), remint ONCE and
// replay the request. Without this a revoked token would stay cached and break
// every call until it expired (up to ~1h). Retries at most once.
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

// Resolves a TMG user's email to their Zoho CRM user id, so records can be
// created with the actual logged-in submitter as Owner (a Zoho user-lookup
// field — plain names/emails in the record body are silently ignored, which
// is why Owner used to always default to whoever owns the API connection).
// Best-effort: returns null (caller proceeds without setting Owner) on any
// failure — a bad/unmatched email should never block the record from saving.
async function resolveZohoOwnerId(
  sb: any,
  conn: any,
  accessToken: string,
  apiDomain: string,
  email: string
): Promise<string | null> {
  const r = await resolveZohoOwner(sb, conn, accessToken, apiDomain, email, null);
  return r.id;
}

// Fetches the org's full Zoho user list (small org — one page). Sanitized fields only.
async function listZohoUsers(sb: any, conn: any, accessToken: string, apiDomain: string) {
  const url = `https://${apiDomain}/crm/v6/users?type=AllUsers&per_page=200`;
  const res = await zohoFetch(sb, conn, accessToken, url, { method: "GET" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false as const, status: res.status, code: data?.code || null, users: [] as any[] };
  const users = (data?.users || []).map((u: any) => ({
    id: u.id,
    full_name: u.full_name || [u.first_name, u.last_name].filter(Boolean).join(" "),
    email: u.email || "",
    status: u.status || null,          // "active" / "inactive" / "deleted"
    confirm: u.confirm ?? null,        // false = invited but never accepted
    role: u.role?.name || null,
    profile: u.profile?.name || null,
  }));
  return { ok: true as const, status: res.status, users };
}

// Robust owner resolution with a full trace of what was tried — the trace is what
// finally makes silent mis-ownership diagnosable instead of a recurring mystery.
// Strategy 1: Zoho's users/search-by-email endpoint (the original, works for most).
// Strategy 2: list ALL org users and match the email case-insensitively — catches
//   users the search endpoint won't return (e.g. unconfirmed or oddly-indexed).
// Strategy 3 (only if fullName given): exact case-insensitive full-name match,
//   accepted only when unambiguous (exactly one hit).
// Record who submitted a record the app just created in Zoho. Zoho itself only
// ever names the API connection as the creator, so without this the author
// survives nowhere except the edge-function logs, which keep about two days.
// Stamped here rather than by the browser so it reflects the real session, and
// never allowed to fail the request — the record is already saved in Zoho.
async function stampSubmission(
  sb: any, module: string, zohoId: string | null, userId: string | null, name: string | null,
) {
  if (!sb || !zohoId || !userId || userId === "service") return;
  try {
    const { error } = await sb.from("zoho_submissions").insert({
      module, zoho_id: zohoId, submitted_by: userId, submitted_by_name: name,
    });
    if (error) console.error(`[zoho-crm] ${module} submission stamp failed:`, error.message);
  } catch (e) { console.error(`[zoho-crm] ${module} submission stamp threw:`, String(e)); }
}

// The stored Zoho user id for a signed-in app user — the ONLY deterministic
// answer available. Everything below it is guesswork that depends on the
// person happening to own a record the app can read, which is how goals and
// KPIs ended up filed under the API connection owner instead of their author.
async function zohoIdFromProfile(sb: any, userId: string | null): Promise<string | null> {
  if (!sb || !userId || userId === "service") return null;
  try {
    const { data } = await sb.from("profiles").select("zoho_user_id").eq("id", userId).maybeSingle();
    const id = (data?.zoho_user_id || "").trim();
    return id || null;
  } catch (_) { return null; }
}

// The owner a created record must carry: whoever is logged into the APP, never
// whoever owns the Zoho API connection. Zoho silently files an Owner-less
// record under the connection owner, so every create path has to set this —
// which is exactly what kept going wrong, one forgotten call site at a time.
//
// Order of certainty: the id stored on the profile, then the caller's email
// (Zoho rejects an address it doesn't know rather than defaulting), then a
// scope-free harvest by name. The org's grant lacks ZohoCRM.users.READ, so the
// harvest is the only lookup available.
async function ownerForCaller(
  sb: any, conn: any, accessToken: string, apiDomain: string,
  auth: any, ownerEmail: string,
): Promise<{ owner: any | null; warning: string | null; callerName: string | null }> {
  let callerName: string | null = null;
  if (sb && auth?.userId && auth.userId !== "service") {
    try {
      const { data } = await sb.from("profiles")
        .select("first_name, last_name").eq("id", auth.userId).maybeSingle();
      if (data) callerName = [data.first_name, data.last_name].filter(Boolean).join(" ") || null;
    } catch (_) { /* fall through to the other strategies */ }
  }
  // Filing for somebody else is an ADMIN action, and "somebody else" means an
  // address that is not the caller's own, not merely "an address was sent".
  // Symon's app login (manager@) differs from his Zoho user (symon@), so
  // treating any supplied email as delegation would stop him filing for
  // himself. A non-admin always gets their own account no matter what the page
  // asked for, so a page cannot quietly attribute work to a colleague.
  //
  // This has to run BEFORE the stored-id shortcut below. Without it the
  // caller's own Zoho id won every single time, so an admin logging a KPI for
  // another agent filed it under the admin: the right name on screen, the wrong
  // name in Zoho, discovered only when the numbers were counted. Same rule and
  // same order as the Health Goals path in create_record, deliberately, so the
  // create paths cannot drift apart again.
  let callerEmail = "";
  if (sb && auth?.userId && auth.userId !== "service") {
    try {
      const { data: cp } = await sb.from("profiles")
        .select("email").eq("id", auth.userId).maybeSingle();
      callerEmail = String(cp?.email || "").toLowerCase();
    } catch (_) { /* no caller email -> cannot be delegating, fall through */ }
  }
  const target = (ownerEmail || "").trim().toLowerCase();
  if (target && callerEmail && target !== callerEmail && (auth as any)?.isAdmin === true) {
    return { owner: { email: ownerEmail }, warning: null, callerName };
  }

  const storedZohoId = await zohoIdFromProfile(sb, auth?.userId || null);
  if (storedZohoId) return { owner: { id: storedZohoId }, warning: null, callerName };
  if (ownerEmail) return { owner: { email: ownerEmail }, warning: null, callerName };
  if (callerName) {
    const resolved = await resolveZohoOwner(sb, conn, accessToken, apiDomain, "", callerName);
    if (resolved.id) return { owner: { id: resolved.id }, warning: null, callerName };
    return { owner: null, callerName, warning: `Could not match you to a Zoho CRM user (tried name "${callerName}"), so Zoho assigned this record to the API connection owner instead. Detail: ${resolved.trace.join(" → ")}` };
  }
  return { owner: null, callerName, warning: "No account email was available for the submitter, so Zoho assigned this record to the API connection owner instead." };
}

async function resolveZohoOwner(
  sb: any, conn: any, accessToken: string, apiDomain: string,
  email: string, fullName: string | null
): Promise<{ id: string | null; via: string; trace: string[] }> {
  const trace: string[] = [];
  const wanted = (email || "").trim().toLowerCase();
  try {
    if (wanted) {
      const url = `https://${apiDomain}/crm/v6/users/search?email=${encodeURIComponent(wanted)}`;
      const res = await zohoFetch(sb, conn, accessToken, url, { method: "GET" });
      const data = await res.json().catch(() => ({}));
      const hit = data?.users?.[0];
      trace.push(`search-endpoint: HTTP ${res.status}${data?.code ? " " + data.code : ""}, ${data?.users?.length || 0} match(es)`);
      if (res.ok && hit?.id) return { id: hit.id, via: "email-search", trace };
    } else {
      trace.push("search-endpoint: skipped (no email)");
    }

    const all = await listZohoUsers(sb, conn, accessToken, apiDomain);
    trace.push(`all-users: HTTP ${all.status}${(all as any).code ? " " + (all as any).code : ""}, ${all.users.length} user(s) in org`);
    if (all.ok) {
      if (wanted) {
        const byEmail = all.users.find((u: any) => (u.email || "").toLowerCase() === wanted);
        if (byEmail) {
          trace.push(`email match in full list: ${byEmail.full_name} (status=${byEmail.status}, confirmed=${byEmail.confirm})`);
          if (byEmail.status === "active") return { id: byEmail.id, via: "email-list", trace };
          trace.push("matched user is not active in Zoho — cannot assign records to them");
          return { id: null, via: "inactive", trace };
        }
        trace.push("no email match in full list");
      }
      if (fullName) {
        const want = fullName.trim().toLowerCase();
        const byName = all.users.filter((u: any) => (u.full_name || "").trim().toLowerCase() === want && u.status === "active");
        trace.push(`name match "${fullName}": ${byName.length} active hit(s)`);
        if (byName.length === 1) return { id: byName[0].id, via: "name", trace };
      }
    }

    // Scope-free fallback: the users API needs ZohoCRM.users.READ, which this org's
    // OAuth grant may not include — but every RECORD carries its Owner {id, email,
    // name}, readable with the module scopes we definitely have. Scan recent records
    // in a few modules for one owned by (or matching) this person and lift the id.
    const harvested = await harvestOwnerFromRecords(sb, conn, accessToken, apiDomain, wanted, fullName, trace);
    if (harvested) return { id: harvested, via: "record-owner", trace };
  } catch (e) {
    trace.push("error: " + String((e as any)?.message || e));
  }
  return { id: null, via: "none", trace };
}

// Scans up to a few pages of records in owner-diverse modules, building an
// email→Owner.id (and name→Owner.id) map from record ownership. Returns the id
// for the wanted email (preferred) or unambiguous full-name match.
async function harvestOwnerFromRecords(
  sb: any, conn: any, accessToken: string, apiDomain: string,
  wantedEmail: string, fullName: string | null, trace: string[]
): Promise<string | null> {
  const wantName = (fullName || "").trim().toLowerCase();
  const byEmail: Record<string, string> = {};
  const byName: Record<string, Set<string>> = {};
  // Health_Goals included: Gustavo and Luciana own records in no other module,
  // so leaving it out meant they could never be resolved and their goals were
  // filed under the connection owner instead.
  for (const moduleName of ["Tasks", "Agent_KPIs", "Contacts", "Health_Goals"]) {
    for (let page = 1; page <= 3; page++) {
      const url = new URL(`https://${apiDomain}/crm/v6/${moduleName}`);
      url.searchParams.set("fields", "Owner");
      url.searchParams.set("per_page", "200");
      url.searchParams.set("page", String(page));
      url.searchParams.set("sort_by", "Modified_Time");
      url.searchParams.set("sort_order", "desc");
      const res = await zohoFetch(sb, conn, accessToken, url.toString(), { method: "GET" });
      if (res.status === 204) break;
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { trace.push(`harvest ${moduleName} p${page}: HTTP ${res.status} ${data?.code || ""}`); break; }
      for (const rec of data?.data || []) {
        const o = rec?.Owner;
        if (!o?.id) continue;
        const em = (o.email || "").toLowerCase();
        const nm = (o.name || "").trim().toLowerCase();
        if (em && !byEmail[em]) byEmail[em] = o.id;
        if (nm) { (byName[nm] = byName[nm] || new Set()).add(o.id); }
      }
      if (!data?.info?.more_records) break;
    }
    // Stop early once we have what we came for.
    if (wantedEmail && byEmail[wantedEmail]) break;
  }
  trace.push(`harvest: ${Object.keys(byEmail).length} distinct owner email(s) seen across records`);
  if (wantedEmail && byEmail[wantedEmail]) {
    trace.push(`harvest matched email → owner of existing records`);
    return byEmail[wantedEmail];
  }
  if (wantName && byName[wantName] && byName[wantName].size === 1) {
    trace.push(`harvest matched full name "${fullName}" unambiguously`);
    return [...byName[wantName]][0];
  }
  if (wantName && byName[wantName] && byName[wantName].size > 1) trace.push(`harvest name "${fullName}" ambiguous (${byName[wantName].size} ids)`);
  return null;
}

// ── Load the single org Zoho connection row ───────────────────────────
// Contacts field metadata and layout sections, held for the life of a warm
// edge-function instance. These describe the ORG SCHEMA, not a record: they
// change when an admin edits a layout, which is roughly never, while the
// prospect-form window asks for them on every open. Two calls saved per open
// is the difference the user is actually feeling when they say it loads slow.
//
// Deliberately in memory and not in a table: a cold instance simply pays for
// the read again, which is correct, whereas a stale row in Postgres would
// outlive the mistake that wrote it.
const SCHEMA_CACHE = new Map<string, { at: number; value: any }>();
const SCHEMA_TTL_MS = 10 * 60 * 1000;
async function cachedJson(key: string, fetcher: () => Promise<any>) {
  const hit = SCHEMA_CACHE.get(key);
  if (hit && Date.now() - hit.at < SCHEMA_TTL_MS) return hit.value;
  const value = await fetcher();
  if (value) SCHEMA_CACHE.set(key, { at: Date.now(), value });
  return value;
}

async function loadConnection(sb: any) {
  const { data, error } = await sb
    .from("zoho_connection")
    // select * so this deploys safely whether or not the access_token cache
    // columns exist yet — getZohoToken tolerates them being absent.
    .select("*")
    .limit(1)
    .single();
  if (error || !data?.refresh_token)
    throw new Error("Zoho connection not configured. Ask an admin to set it up.");
  return data;
}

// Zoho returns a record's tags as [{ name, id, color_code }]. The app only
// ever shows the name, so everything else is dropped here rather than being
// carried across the wire and ignored on the other side. Absent, null and
// "not an array" all collapse to [] — an empty list is the honest answer for
// a record that was read and has no tags; a read that FAILED is reported as
// null by the caller, never by this function.
function zohoTagNames(tag: unknown): string[] {
  if (!Array.isArray(tag)) return [];
  return tag
    .map((t: any) => (t && typeof t === "object" ? String(t.name ?? "").trim() : String(t ?? "").trim()))
    .filter((n: string) => n.length > 0);
}

// ── Fuzzy name-matching helpers (for match_contacts) ──────────────────
function lev(a: string, b: string): number {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function ratio(a: string, b: string): number {
  const L = Math.max(a.length, b.length);
  return L ? 1 - lev(a, b) / L : 1;
}
// Token-aware similarity between a typed name and a candidate full name (0..1).
function nameScore(typed: string, candidate: string): number {
  const tt = typed.toLowerCase().split(/\s+/).filter(Boolean);
  const ct = candidate.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tt.length || !ct.length) return 0;
  let total = 0;
  for (const t of tt) {
    let best = 0;
    for (const c of ct) best = Math.max(best, ratio(t, c));
    total += best;
  }
  return total / tt.length;
}

// A call NEVER belongs on an Agent_KPI record — it is written as a Task instead.
//
// An Agent_KPI person row carrying "Touch Call" is what makes Zoho raise a
// "Validate <tier> Touch Call" task for a human to check by hand. The app now
// shows the agent when the contact was last called, so that check has no
// purpose. Zoho Reports counts Tasks by Task Type anyway, so a call written
// straight to Tasks is counted exactly once with no chore attached.
//
// This lives on the SERVER, not in a page, because there are three separate
// screens that submit KPIs and fixing them one at a time is precisely how they
// drifted apart before. Anything that reaches this action is covered, including
// screens nobody has written yet.
const CALL_KPI_LABELS = ["Touch Call", "Follow Up Call"];
const MAX_KPI_PERSONS = 10;

async function splitCallsOutOfKpi(
  sb: any, conn: any, accessToken: string, apiDomain: string,
  record: any, kpiDate: string, owner: any,
): Promise<{ made: number; failed: string[] }> {
  // Pull the person rows apart into calls vs everything else.
  const rows: any[] = [];
  for (let i = 1; i <= MAX_KPI_PERSONS; i++) {
    const kpis = record[`Person_${i}_Applicable_KPIs`];
    if (!Array.isArray(kpis) || !kpis.length) continue;
    rows.push({
      name: record[`Person_${i}_Name`] || null,
      hotzone: record[`Number_of_Hotzone_Actions_${i}`] ?? null,
      calls: kpis.filter((k: string) => CALL_KPI_LABELS.includes(k)),
      rest: kpis.filter((k: string) => !CALL_KPI_LABELS.includes(k)),
    });
  }
  if (!rows.some((r) => r.calls.length)) return { made: 0, failed: [] };

  let made = 0;
  const failed: string[] = [];
  for (const r of rows) {
    if (!r.calls.length) continue;
    const cid = r.name?.id || null;
    // The tier is a property of the CONTACT, read from the field that actually
    // holds it rather than guessed from an old task's subject line.
    let full = "", tier = "";
    if (cid) {
      try {
        const cr = await zohoFetch(sb, conn, accessToken,
          `https://${apiDomain}/crm/v6/Contacts/${cid}?fields=Full_Name,Client_Classification`, {});
        if (cr.ok && cr.status !== 204) {
          const cd = await cr.json().catch(() => ({}));
          const c = cd?.data?.[0];
          full = c?.Full_Name || "";
          const cls = String(c?.Client_Classification || "").trim().toUpperCase();
          if (/^[ABC]$/.test(cls)) tier = cls;
        }
      } catch (_) { /* subject just goes out without the letter */ }
    }
    const who = full || r.name?.name || "";
    for (const k of r.calls) {
      // Matches the subjects Zoho's own workflow writes: a space before the
      // colon on follow-ups, the tier letter in front of a touch.
      const subject = k === "Touch Call"
        ? `${tier ? tier + " " : ""}Touch Call: ${who}`
        : `Follow Up Call : ${who}`;
      const task: any = { Subject: subject, Status: "Completed", Task_Type: "Call", Due_Date: kpiDate };
      if (cid) task.Who_Id = { id: cid };
      if (owner) task.Owner = owner;
      try {
        const tr = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Tasks`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: [task] }),
        });
        const td = await tr.json().catch(() => ({}));
        if (tr.ok && td?.data?.[0]?.status === "success") made++;
        else failed.push(`${who || "unknown"} — ${td?.data?.[0]?.message || "Zoho refused the task"}`);
      } catch (e) { failed.push(`${who || "unknown"} — ${String(e)}`); }
    }
  }

  // Rewrite the person rows with the calls removed. Survivors are compacted into
  // Person_1..N so the record never carries a gap, and a person whose ONLY entry
  // was a call drops off entirely.
  for (let i = 1; i <= MAX_KPI_PERSONS; i++) {
    delete record[`Person_${i}_Name`];
    delete record[`Person_${i}_Applicable_KPIs`];
    delete record[`Number_of_Hotzone_Actions_${i}`];
  }
  let slot = 0;
  for (const r of rows) {
    if (!r.rest.length) continue;
    slot++;
    if (r.name) record[`Person_${slot}_Name`] = r.name;
    record[`Person_${slot}_Applicable_KPIs`] = r.rest;
    if (r.hotzone != null && r.rest.some((k: string) => /hotzone/i.test(k))) {
      record[`Number_of_Hotzone_Actions_${slot}`] = r.hotzone;
    }
  }
  return { made, failed };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const auth = await authorizeCaller(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    const sb = auth.sb;

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // ── Create Agent KPI record ─────────────────────────────────────
    if (action === "create_agent_kpi") {
      const record = body.record;
      if (!record || typeof record !== "object")
        return json({ error: "Missing record." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const moduleName = conn.module_api_name || "Agent_KPIs";

      // Submitting through the app IS the agreement — stamp the module's consent
      // picklist ("You agree that once it's saved, it can't be edited") the same way
      // Zoho's own form does, so app records don't sit blank on this field.
      record.You_agree_that_once_it_s_saved_it_can_t_be_edited = "Yes";

      // Owner = whoever is actually logged in, not whoever owns the Zoho connection.
      // Best-effort: if the email doesn't resolve to a Zoho user, Zoho falls back to
      // its old default (API-connection owner) rather than the create failing. That
      // fallback is reported back as owner_warning so a mis-owned record is visible
      // at submit time instead of being discovered in Zoho weeks later.
      let ownerWarning: string | null = null;
      const ownerEmail = typeof body.owner_email === "string" ? body.owner_email.trim() : "";
      // Shared with create_record and create_contact, so the three create paths
      // cannot drift apart again — a forgotten Owner on any one of them is the
      // "assigned to Symon again" report.
      const ownerRes = await ownerForCaller(sb, conn, accessToken, apiDomain, auth, ownerEmail);
      if (ownerRes.owner) record.Owner = ownerRes.owner;
      ownerWarning = ownerRes.warning;
      const callerName = ownerRes.callerName;

      // Calls come off the record and become Tasks, so no validation chore is
      // raised. Whatever is left (notes, hotzone, pop-by, lunch, CTC hours,
      // other KPIs) still rides the Agent_KPI record, which generates its own
      // tasks for those.
      const callSplit = await splitCallsOutOfKpi(
        sb, conn, accessToken, apiDomain, record,
        String(record.KPI_Date || "").slice(0, 10), record.Owner || null,
      );
      // A submission that was ONLY calls has nothing left to file: the calls are
      // already saved as Tasks, so posting an empty record would create a blank
      // Agent_KPI row rather than represent anything.
      const nothingLeft = !record.Person_1_Applicable_KPIs
        && record.CTC_Hours_2 == null && !record.Other_KPI_1;
      if (nothingLeft) {
        return json({
          ok: true, id: null, calls_logged: callSplit.made,
          call_failures: callSplit.failed.length ? callSplit.failed : undefined,
          owner_warning: ownerWarning,
        }, 200);
      }

      const crmRes = await zohoFetch(
        sb, conn, accessToken,
        `https://${apiDomain}/crm/v6/${moduleName}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: [record] }),
        }
      );
      const crmData = await crmRes.json();
      if (!crmRes.ok) {
        const msg =
          crmData?.data?.[0]?.message ||
          crmData?.message ||
          "Zoho CRM error";
        return json({ error: msg, detail: crmData }, crmRes.status);
      }

      const created = crmData?.data?.[0];
      await stampSubmission(sb, moduleName, created?.details?.id || null, auth.userId, callerName);
      return json(
        {
          ok: true,
          id: created?.details?.id || null,
          status: created?.status || "success",
          owner_warning: ownerWarning,
          // Reported so a caller can say what actually happened, and so a call
          // that Zoho refused is visible at submit time rather than simply
          // missing from the KPI count later.
          calls_logged: callSplit.made,
          call_failures: callSplit.failed.length ? callSplit.failed : undefined,
        },
        200
      );
    }

    // ── Create a Health Goal (owner = the signed-in member) ─────────
    // Same owner-resolution path as create_agent_kpi: Zoho otherwise assigns
    // every app-created record to the API connection owner.
    if (action === "create_health_goal") {
      const goal = typeof body.goal === "string" ? body.goal.trim() : "";
      const month = typeof body.month === "string" ? body.month.trim() : "";
      const status = typeof body.status === "string" ? body.status.trim() : "";
      if (!goal) return json({ error: "Missing goal." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      const record: Record<string, unknown> = { Health_Goal_s: goal };
      if (month) record.Month_of = month;
      if (status) record.Goal_Status = status;

      let ownerWarning: string | null = null;
      const ownerEmail = typeof body.owner_email === "string" ? body.owner_email.trim() : "";
      let callerName: string | null = null;
      if (auth.userId && auth.userId !== "service") {
        const { data: callerProf } = await sb
          .from("profiles").select("first_name, last_name").eq("id", auth.userId).maybeSingle();
        if (callerProf) callerName = [callerProf.first_name, callerProf.last_name].filter(Boolean).join(" ") || null;
      }
      // Owner, in order of certainty:
      //   1. the id stored on their profile — exact, and covers people whose
      //      app login differs from their Zoho address (Symon: manager@ vs symon@);
      //   2. their email — Zoho resolves the address to its own user itself, so
      //      no users.READ scope and no id needed. An address Zoho doesn't know
      //      is REJECTED outright (INVALID_DATA on Owner.email, record left
      //      untouched — verified live), so this cannot misfile the way the old
      //      "let Zoho default the owner" path did;
      //   3. nothing usable → refuse, rather than let Zoho default it to the API
      //      connection owner and file one person's goal under Symon's name.
      // Filing for someone else is an admin action, and "someone else" means an
      // address that isn't the caller's own — not merely "an address was sent".
      // Symon's app login (manager@) differs from his Zoho user (symon@), so
      // treating any supplied email as delegation would break him filing for
      // himself. Non-admins always get their own account regardless of what the
      // page asked for, so a page can't quietly attribute a goal to a colleague.
      let callerZohoId: string | null = null;
      let callerEmail = "";
      if (auth.userId && auth.userId !== "service") {
        const { data: cp } = await sb
          .from("profiles").select("zoho_user_id, email").eq("id", auth.userId).maybeSingle();
        callerZohoId = (cp?.zoho_user_id || "").trim() || null;
        callerEmail = String(cp?.email || "").toLowerCase();
      }
      const target = ownerEmail.toLowerCase();
      const delegating = !!target && target !== callerEmail && (auth as any).isAdmin === true;
      if (delegating) record.Owner = { email: ownerEmail };
      else if (callerZohoId) record.Owner = { id: callerZohoId };
      else if (ownerEmail) record.Owner = { email: ownerEmail };
      else {
        return json({
          error: "We couldn't tell which account this goal belongs to, so it wasn't saved — saving it would have filed it under someone else's name. Tell Symon.",
        }, 409);
      }

      const r = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Health_Goals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [record] }),
      });
      const d = await r.json().catch(() => ({}));
      const row = d?.data?.[0];
      if (!r.ok || row?.status !== "success") {
        // Zoho rejects an owner address it doesn't recognise instead of
        // defaulting the owner — say that in words the submitter can act on
        // rather than showing them "invalid data".
        const badOwner = String(row?.details?.json_path || "").indexOf("Owner") !== -1;
        if (badOwner) return json({
          error: `Zoho doesn't recognise ${ownerEmail || "your email address"} as one of its users, so this goal wasn't saved — it would have been filed under someone else's name. Ask Symon to add you as a Zoho CRM user.`,
          detail: d,
        }, 409);
        return json({ error: row?.message || d?.message || "Could not create health goal", detail: d }, r.ok ? 400 : r.status);
      }
      // Record who submitted it, permanently. Zoho only ever names the API
      // connection as creator, so without this the author survives nowhere
      // except the edge-function logs, which keep ~2 days. Written here rather
      // than by the browser so it reflects the actual session.
      const newId = row?.details?.id || null;
      await stampSubmission(sb, "Health_Goals", newId, auth.userId, callerName);
      return json({ ok: true, id: newId, owner_warning: ownerWarning }, 200);
    }

    // ── Owner diagnosis (ops/admin only) ────────────────────────────
    // Returns the org's Zoho user directory (sanitized) plus a full resolution
    // trace for each given email/name pair — the tool that ends the "records
    // keep getting assigned to the wrong owner and nobody can see why" loop.
    if (action === "owner_diagnosis") {
      if (!(auth as any).isService) {
        // Non-service callers must be active admins.
        const { data: prof } = await sb.from("profiles").select("access").eq("id", auth.userId).maybeSingle();
        const roles = Array.isArray(prof?.access) ? prof.access : [];
        if (!roles.includes("admin")) return json({ error: "Admin access required." }, 403);
      }
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const all = await listZohoUsers(sb, conn, accessToken, apiDomain);
      const checks: any[] = [];
      const targets = Array.isArray(body.targets) ? body.targets.slice(0, 20) : [];
      for (const t of targets) {
        const email = typeof t?.email === "string" ? t.email : "";
        const name = typeof t?.name === "string" ? t.name : null;
        const r = await resolveZohoOwner(sb, conn, accessToken, apiDomain, email, name);
        checks.push({ email, name, resolved_id: r.id, via: r.via, trace: r.trace });
      }
      return json({ ok: true, zoho_users: all.users, checks }, 200);
    }

    // ── Search contacts by name (fuzzy) ─────────────────────────────
    if (action === "search_contacts") {
      const query = (body.query || "").trim();
      if (!query || query.length < 2)
        return json({ error: "Query too short (min 2 chars)." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      // Zoho CRM Search Records — word search across name fields
      const url = new URL(`https://${apiDomain}/crm/v6/Contacts/search`);
      url.searchParams.set("word", query);
      url.searchParams.set("per_page", "10");

      const crmRes = await zohoFetch(sb, conn, accessToken, url.toString(), {});

      // 204 = no results (Zoho returns empty body with 204)
      if (crmRes.status === 204) return json({ contacts: [] }, 200);

      const crmData = await crmRes.json();
      if (!crmRes.ok) {
        const msg = crmData?.message || "Zoho search error";
        return json({ error: msg }, crmRes.status);
      }

      const contacts = (crmData.data || []).map((c: any) => ({
        id: c.id,
        full_name: c.Full_Name || `${c.First_Name || ""} ${c.Last_Name || ""}`.trim(),
        first_name: c.First_Name || "",
        last_name: c.Last_Name || "",
        email: c.Email || null,
        phone: c.Phone || c.Mobile || null,
      }));

      return json({ contacts }, 200);
    }

    // ── Find the Deal behind a CTC file, for the Overview's Deal details
    // block. A CTC file's name IS the property address, and so is the deal
    // name, so a word search on the address is the match. Display-only and
    // deliberately narrow: this block must never become a second source of
    // truth for anything TMG already tracks itself. [CRM] ──
    if (action === "search_deals") {
      const query = (body.query || "").trim();
      if (!query || query.length < 2)
        return json({ error: "Query too short (min 2 chars)." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      const url = new URL(`https://${apiDomain}/crm/v6/Deals/search`);
      url.searchParams.set("word", query);
      url.searchParams.set("per_page", "10");

      const crmRes = await zohoFetch(sb, conn, accessToken, url.toString(), {});

      // 204 = no results. A CTC file with no matching deal is normal, not an
      // error — the block just doesn't render.
      if (crmRes.status === 204) return json({ deal: null, count: 0 }, 200);

      const crmData = await crmRes.json();
      if (!crmRes.ok) {
        const msg = crmData?.message || "Zoho deal search error";
        return json({ error: msg }, crmRes.status);
      }

      const lookupName = (v: any) => (v && typeof v === "object" ? (v.name || null) : (v || null));
      const deals = (crmData.data || []).map((d: any) => ({
        id: d.id,
        name: d.Deal_Name || null,
        stage: d.Stage || null,
        amount: d.Amount ?? null,
        closing_date: d.Closing_Date || null,
        type: d.Type || null,
        account: lookupName(d.Account_Name),
        contact: lookupName(d.Contact_Name),
        owner: lookupName(d.Owner),
      }));

      // Zoho's word search is broad ("888" matches plenty), so rank rather
      // than trusting result order.
      //
      // Real deal names here are "<client names> <address>" —
      // e.g. "Albert Vila Tarres & Sara Vanderlinden 1903 Frazier Ave #A" —
      // NOT the bare address a CTC file is named after. So the test is
      // CONTAINMENT, not prefix: does the file's address appear inside the
      // deal name? A prefix match would miss essentially every real deal,
      // because they all start with the clients' names.
      const norm = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const q = norm(query);
      const score = (d: any) => {
        const n = norm(d.name);
        if (!n || !q) return 0;
        if (n === q) return 1000;
        if (n.includes(q)) return 500 + q.length;   // the address sits inside the deal name
        if (q.includes(n)) return 400 + n.length;   // deal name is the shorter side
        let i = 0; while (i < n.length && i < q.length && n[i] === q[i]) i++;
        return i;
      };
      const ranked = deals.slice().sort((a: any, b: any) => score(b) - score(a));
      const best = ranked[0] && score(ranked[0]) > 0 ? ranked[0] : null;

      return json({ deal: best, count: deals.length }, 200);
    }

    // ── Plain record listing, read-only [CRM] ──
    // Zoho's /search endpoint refuses Created_Time criteria on some modules
    // ("Invalid query formed"), so anything date-scoped has to come off the
    // plain records endpoint and be filtered here. Reads only.
    if (action === "list_records") {
      const moduleName = String(body.module || "Contacts").trim().replace(/[^A-Za-z0-9_]/g, "");
      const fields = Array.isArray(body.fields)
        ? body.fields.map((f: string) => String(f).replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean).slice(0, 20)
        : [];
      const sortBy = String(body.sort_by || "Created_Time").replace(/[^A-Za-z0-9_]/g, "");
      const sortOrder = String(body.sort_order || "desc") === "asc" ? "asc" : "desc";
      const maxPages = Math.min(Number(body.max_pages) || 5, 40);
      const stopBefore = typeof body.stop_before === "string" ? body.stop_before : null;
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const rows: any[] = [];
      let page = 1, more = false;
      while (page <= maxPages) {
        const url = new URL(`https://${apiDomain}/crm/v6/${moduleName}`);
        if (fields.length) url.searchParams.set("fields", fields.join(","));
        url.searchParams.set("per_page", "200");
        url.searchParams.set("page", String(page));
        url.searchParams.set("sort_by", sortBy);
        url.searchParams.set("sort_order", sortOrder);
        const r = await zohoFetch(sb, conn, accessToken, url.toString(), {});
        if (r.status === 204) break;
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: d?.message || `HTTP ${r.status}`, detail: d, rows }, 200);
        const batch = d.data || [];
        rows.push(...batch);
        more = !!d?.info?.more_records;
        // descending sort + a floor value: stop as soon as we are past it
        if (stopBefore && batch.length && String(batch[batch.length - 1]?.[sortBy] || "") < stopBefore) { more = false; break; }
        if (!more) break;
        page++;
      }
      return json({ rows, count: rows.length, more_records: more }, 200);
    }

    // ── Criteria search, read-only [CRM] ──
    // search_deals word-matches one record at a time, so "every deal where
    // Stage = X" had no route. COQL needs a scope this connection lacks, but
    // the module search endpoint takes the same filters under the plain
    // modules.READ scope we already hold. Reads only.
    if (action === "search_records") {
      const moduleName = String(body.module || "Deals").trim().replace(/[^A-Za-z0-9_]/g, "");
      const criteria = String(body.criteria || "").trim();
      if (!criteria) return json({ error: "Missing criteria." }, 400);
      const fields = Array.isArray(body.fields)
        ? body.fields.map((f: string) => String(f).replace(/[^A-Za-z0-9_]/g, "")).filter(Boolean).slice(0, 20)
        : [];
      const maxPages = Math.min(Number(body.max_pages) || 5, 20);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const rows: any[] = [];
      let page = 1, more = false;
      while (page <= maxPages) {
        const url = new URL(`https://${apiDomain}/crm/v6/${moduleName}/search`);
        url.searchParams.set("criteria", criteria);
        url.searchParams.set("per_page", "200");
        url.searchParams.set("page", String(page));
        if (fields.length) url.searchParams.set("fields", fields.join(","));
        const r = await zohoFetch(sb, conn, accessToken, url.toString(), {});
        if (r.status === 204) break;
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: d?.message || `HTTP ${r.status}`, detail: d, rows }, 200);
        rows.push(...(d.data || []));
        more = !!d?.info?.more_records;
        if (!more) break;
        page++;
      }
      return json({ rows, count: rows.length, more_records: more }, 200);
    }

    // ── List CRM modules (metadata only — no records touched) [CRM] ──
    if (action === "list_modules") {
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      const crmRes = await zohoFetch(
        sb, conn, accessToken,
        `https://${apiDomain}/crm/v6/settings/modules`,
        {}
      );
      if (crmRes.status === 204) return json({ modules: [] }, 200);
      const crmData = await crmRes.json();
      if (!crmRes.ok) {
        const msg = crmData?.message || "Zoho modules error";
        return json({ error: msg, detail: crmData }, crmRes.status);
      }

      const modules = (crmData.modules || [])
        .filter((m: any) => m.api_supported && m.visible !== false)
        .map((m: any) => ({
          api_name: m.api_name,
          plural_label: m.plural_label,
          singular_label: m.singular_label,
          module_name: m.module_name,
          generated_type: m.generated_type,
          creatable: m.creatable,
          editable: m.editable,
          deletable: m.deletable,
          viewable: m.viewable,
        }));

      return json({ modules }, 200);
    }

    // ── List a module's fields (metadata only — no records touched) [CRM] ──
    if (action === "get_fields") {
      const moduleName = (body.module || "").trim();
      if (!moduleName) return json({ error: "Missing module." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      const url = new URL(`https://${apiDomain}/crm/v6/settings/fields`);
      url.searchParams.set("module", moduleName);

      const crmRes = await zohoFetch(sb, conn, accessToken, url.toString(), {});
      if (crmRes.status === 204) return json({ fields: [] }, 200);
      const crmData = await crmRes.json();
      if (!crmRes.ok) {
        const msg = crmData?.message || "Zoho fields error";
        return json({ error: msg, detail: crmData }, crmRes.status);
      }

      const fields = (crmData.fields || [])
        .filter((f: any) => f.view_type?.view !== false || f.api_name)
        .map((f: any) => ({
          api_name: f.api_name,
          field_label: f.field_label,
          data_type: f.data_type,
          length: f.length ?? null,
          required: !!(f.system_mandatory || f.required),
          read_only: !!f.read_only,
          custom_field: !!f.custom_field,
          picklist_values: Array.isArray(f.pick_list_values)
            ? f.pick_list_values
                .filter((p: any) => p.type !== "deleted_value")
                .map((p: any) => p.display_value)
            : null,
          lookup_module: f.lookup?.module?.api_name || null,
          tooltip: f.tooltip?.value || null,
        }));

      return json({ module: moduleName, count: fields.length, fields }, 200);
    }


    // ── Parties on a deal ─────────────────────────────────────────────
    //  "Parties" is the Participants module; a party is attached to a deal
    //  through the Deals_X_Participants linking module, which is many-to-many
    //  by design — Kara Killion is one Party record that closes several deals,
    //  not a fresh row per transaction. So reading them is two hops: the links
    //  for this deal, then the party records those links point at.
    //
    //  The link's own lookup carries only {id, name}, which is not enough to
    //  render a table (no role, company, email or phone), hence the second
    //  fetch. `ids` takes the whole set in one request rather than N.
    const PARTY_FIELDS = ["Name", "Role", "Company", "Title", "Email", "Mobile_Number"];
    const partyOut = (p: any, linkId: string | null = null) => ({
      id: p.id,
      link_id: linkId,
      name: p.Name || null,
      role: p.Role && p.Role !== "-None-" ? p.Role : null,
      company: p.Company || null,
      title: p.Title || null,
      email: p.Email || null,
      phone: p.Mobile_Number || null,
    });

    if (action === "deal_parties") {
      const dealId = String(body.deal_id || "").replace(/[^0-9]/g, "");
      if (!dealId) return json({ error: "Missing deal_id." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      const lu = new URL(`https://${apiDomain}/crm/v6/Deals_X_Participants/search`);
      lu.searchParams.set("criteria", `(Deals:equals:${dealId})`);
      lu.searchParams.set("per_page", "200");
      const lr = await zohoFetch(sb, conn, accessToken, lu.toString(), {});
      if (lr.status === 204) return json({ parties: [], count: 0 }, 200);
      const ld = await lr.json().catch(() => ({}));
      if (!lr.ok) return json({ error: ld?.message || "Couldn't read this deal's parties.", detail: ld }, lr.status);

      // linkByParty, not a plain list: a party linked twice to the same deal
      // (possible if someone adds it in Zoho directly) should still render once.
      const linkByParty = new Map<string, string>();
      for (const row of (ld.data || [])) {
        const pid = row?.Parties?.id;
        if (pid && !linkByParty.has(String(pid))) linkByParty.set(String(pid), String(row.id));
      }
      if (!linkByParty.size) return json({ parties: [], count: 0 }, 200);

      const pu = new URL(`https://${apiDomain}/crm/v6/Participants`);
      pu.searchParams.set("ids", [...linkByParty.keys()].join(","));
      pu.searchParams.set("fields", PARTY_FIELDS.join(","));
      const pr = await zohoFetch(sb, conn, accessToken, pu.toString(), {});
      if (pr.status === 204) return json({ parties: [], count: 0 }, 200);
      const pd = await pr.json().catch(() => ({}));
      if (!pr.ok) return json({ error: pd?.message || "Couldn't read the party records.", detail: pd }, pr.status);

      const parties = (pd.data || []).map((p: any) => partyOut(p, linkByParty.get(String(p.id)) || null));
      // Group the table the way the transaction reads, not the way Zoho
      // happens to return it.
      const ORDER = ["Seller", "Buyer", "Agent (Other Side)", "Agent TC (Other Side)", "Closer", "Closer Assistant", "Lender", "Attorney", "Inspector", "Surveyor", "Closer (Other Side)"];
      parties.sort((a: any, b: any) => {
        const ia = ORDER.indexOf(a.role || ""), ib = ORDER.indexOf(b.role || "");
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || String(a.name || "").localeCompare(String(b.name || ""));
      });
      return json({ parties, count: parties.length }, 200);
    }

    // ── Autocomplete over parties that already exist [read-only] ──────
    //  The point of the many-to-many is reuse: the same closer, inspector and
    //  lender come back deal after deal. Typing a name that already exists
    //  should offer the existing record instead of quietly minting a second
    //  "Kara Killion" that splits her history in two.
    if (action === "search_parties") {
      const query = String(body.query || "").trim();
      if (query.length < 2) return json({ parties: [], count: 0 }, 200);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      const u = new URL(`https://${apiDomain}/crm/v6/Participants/search`);
      u.searchParams.set("word", query);
      u.searchParams.set("per_page", "25");
      u.searchParams.set("fields", PARTY_FIELDS.join(","));
      const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
      if (r.status === 204) return json({ parties: [], count: 0 }, 200);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.message || "Party search failed.", detail: d }, r.status);

      // Zoho's word search matches across every field, so a query like "title"
      // drags in everyone whose COMPANY contains it. Rank by how well the name
      // itself matches and let the caller show the best first.
      const norm = (s: unknown) => String(s || "").toLowerCase();
      const q = norm(query);
      const parties = (d.data || []).map((p: any) => partyOut(p));
      parties.sort((a: any, b: any) => {
        const sc = (p: any) => {
          const n = norm(p.name);
          if (n === q) return 3;
          if (n.startsWith(q)) return 2;
          if (n.includes(q)) return 1;
          return 0;
        };
        return sc(b) - sc(a) || String(a.name || "").localeCompare(String(b.name || ""));
      });
      return json({ parties, count: parties.length }, 200);
    }

    // ── Attach a party to a deal — existing one, or a new one [write] ──
    //  Two doors, one action. `party_id` links a party that already exists;
    //  a `party` object creates the record first and then links it. Both end
    //  at the same place, so the UI does not have to branch.
    if (action === "add_party") {
      const dealId = String(body.deal_id || "").replace(/[^0-9]/g, "");
      if (!dealId) return json({ error: "Missing deal_id." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      let partyId = String(body.party_id || "").replace(/[^0-9]/g, "");
      let createdParty: any = null;

      // Whoever is typing owns what they type. Zoho files an Owner-less record
      // under the API connection's own user, which is why every new party was
      // landing on Symon no matter who added it. Resolved once and used for
      // both the party record and the link record below.
      const partyOwnerEmail = typeof body.owner_email === "string" ? body.owner_email.trim() : "";
      const partyOwnerRes = await ownerForCaller(sb, conn, accessToken, apiDomain, auth, partyOwnerEmail);
      const partyOwner = partyOwnerRes.owner;

      if (!partyId) {
        const spec = body.party || {};
        const name = String(spec.name || "").trim();
        if (!name) return json({ error: "A party needs a name." }, 400);
        const rec: Record<string, any> = { Name: name };
        const role = String(spec.role || "").trim();
        if (role && role !== "-None-") rec.Role = role;
        if (String(spec.company || "").trim()) rec.Company = String(spec.company).trim();
        if (String(spec.email || "").trim()) rec.Email = String(spec.email).trim();
        if (String(spec.phone || "").trim()) rec.Mobile_Number = String(spec.phone).trim();
        if (partyOwner) rec.Owner = partyOwner;

        const cr = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Participants`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: [rec] }),
        });
        const cd = await cr.json().catch(() => ({}));
        const crow = cd?.data?.[0];
        if (!cr.ok || crow?.status !== "success")
          return json({ error: crow?.message || cd?.message || "Zoho wouldn't create that party.", detail: cd }, cr.ok ? 400 : cr.status);
        partyId = String(crow?.details?.id || "");
        createdParty = { ...partyOut({ id: partyId, Name: name, Role: rec.Role, Company: rec.Company, Email: rec.Email, Mobile_Number: rec.Mobile_Number }) };
      }
      if (!partyId) return json({ error: "No party to attach." }, 400);

      // Already on this deal? Say so rather than stacking a second identical
      // link — the table would show the person twice and neither row would be
      // obviously the one to remove.
      const cu = new URL(`https://${apiDomain}/crm/v6/Deals_X_Participants/search`);
      cu.searchParams.set("criteria", `((Deals:equals:${dealId})and(Parties:equals:${partyId}))`);
      const cr2 = await zohoFetch(sb, conn, accessToken, cu.toString(), {});
      if (cr2.ok && cr2.status !== 204) {
        const cd2 = await cr2.json().catch(() => ({}));
        if ((cd2.data || []).length)
          return json({ error: "That party is already on this deal.", already: true, party_id: partyId }, 409);
      }

      const lr = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Deals_X_Participants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [{ Deals: { id: dealId }, Parties: { id: partyId }, ...(partyOwner ? { Owner: partyOwner } : {}) }] }),
      });
      const ld = await lr.json().catch(() => ({}));
      const lrow = ld?.data?.[0];
      if (!lr.ok || lrow?.status !== "success") {
        // The party record itself may have just been created. Say that plainly
        // — otherwise a retry makes a second copy of the same person.
        return json({
          error: (lrow?.message || ld?.message || "Zoho wouldn't attach that party to the deal.")
            + (createdParty ? " The party record WAS created — attach it from the picker instead of retyping it." : ""),
          detail: ld, party_id: partyId, party_created: !!createdParty,
        }, lr.ok ? 400 : lr.status);
      }

      // Permanent record of who added them. Zoho only ever names the API
      // connection as creator, so without this the author survives nowhere.
      if (createdParty) await stampSubmission(sb, "Participants", partyId, auth.userId, partyOwnerRes.callerName);
      return json({
        ok: true, party_id: partyId, link_id: lrow?.details?.id || null,
        created: !!createdParty, owner_warning: partyOwnerRes.warning,
      }, 200);
    }

    // ── Detach a party from a deal [write] ────────────────────────────
    //  Deletes the LINK, never the party. Removing Kara Killion from one deal
    //  must not remove her from the other three.
    if (action === "remove_party") {
      const linkId = String(body.link_id || "").replace(/[^0-9]/g, "");
      if (!linkId) return json({ error: "Missing link_id." }, 400);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const u = new URL(`https://${apiDomain}/crm/v6/Deals_X_Participants`);
      u.searchParams.set("ids", linkId);
      const r = await zohoFetch(sb, conn, accessToken, u.toString(), { method: "DELETE" });
      const d = await r.json().catch(() => ({}));
      const row = d?.data?.[0];
      if (!r.ok || row?.status !== "success")
        return json({ error: row?.message || d?.message || "Couldn't take that party off the deal.", detail: d }, r.ok ? 400 : r.status);
      return json({ ok: true }, 200);
    }

    // ── Create ONE custom field in a module [write, admin-only] ──────
    //  Two-step by design: the same action previews and creates, and it only
    //  writes when the caller passes confirm:true. A field is not a record --
    //  Zoho has no API to delete one and no undo, the api_name it generates is
    //  permanent, and every module has a hard per-edition cap on custom fields.
    //  So the cheap half (validate the spec, check the label isn't already
    //  taken, count how much room is left) always runs first and returns the
    //  exact JSON that a later confirm would post.
    //
    //  Deliberately one field per call even though Zoho accepts five. A partial
    //  failure inside a five-field batch leaves some created and some not, with
    //  no way to roll the created ones back.
    //
    //  Needs ZohoCRM.settings.fields.CREATE, which ZohoCRM.settings.ALL covers.
    //  The reconnect card's scope line already asks for settings.ALL, but a
    //  grant issued before that was added will 401 here -- which is why an
    //  OAUTH_SCOPE_MISMATCH is translated into "re-authorize" rather than
    //  surfaced raw.
    if (action === "create_field") {
      if (!(auth as any).isService) {
        const { data: prof } = await sb.from("profiles").select("access").eq("id", auth.userId).maybeSingle();
        const roles = Array.isArray(prof?.access) ? prof.access : [];
        if (!roles.includes("admin")) return json({ error: "Admin access required." }, 403);
      }

      const moduleName = String(body.module || "").trim();
      if (!moduleName) return json({ error: "Missing module." }, 400);
      const spec = body.field;
      if (!spec || typeof spec !== "object") return json({ error: "Missing field spec." }, 400);

      // Types this action will build. Deliberately excludes formula, lookup,
      // autonumber, fileupload and imageupload: each needs its own object and
      // its own validation, and each is a bigger footgun than the plain types
      // (a lookup rewires two modules; an autonumber can renumber every
      // existing record). Adding one later is additive -- adding it blind is
      // not. LIMITS mirrors Zoho's published length table exactly.
      const LIMITS: Record<string, { min: number; max: number } | null> = {
        text: { min: 1, max: 255 },
        textarea: null,          // length comes from the textarea type
        email: { min: 1, max: 100 },
        phone: { min: 1, max: 30 },
        website: { min: 1, max: 450 },
        integer: { min: 1, max: 9 },
        bigint: { min: 1, max: 18 },
        double: { min: 1, max: 18 },
        currency: { min: 1, max: 16 },
        percent: { min: 1, max: 5 },
        date: null,
        datetime: null,
        boolean: null,
        picklist: null,
        multiselectpicklist: null,
      };

      const label = String(spec.label || spec.field_label || "").trim();
      const dataType = String(spec.data_type || "").trim().toLowerCase();
      if (!label) return json({ error: "Give the field a label." }, 400);
      if (label.length > 50) return json({ error: "Field labels are capped at 50 characters." }, 400);
      if (!(dataType in LIMITS))
        return json({ error: `This tool doesn't create "${dataType || "(blank)"}" fields. Supported: ${Object.keys(LIMITS).join(", ")}.` }, 400);

      // Build exactly what Zoho will be posted, so the preview can show it and
      // the confirm step has nothing left to decide.
      const field: Record<string, any> = { field_label: label, data_type: dataType };
      const notes: string[] = [];

      const lim = LIMITS[dataType];
      if (lim) {
        const wanted = Number(spec.length);
        const len = Number.isFinite(wanted) && wanted > 0 ? Math.round(wanted) : lim.max;
        if (len < lim.min || len > lim.max)
          return json({ error: `Length for ${dataType} must be between ${lim.min} and ${lim.max}.` }, 400);
        field.length = len;
      }

      if (dataType === "textarea") {
        const t = String(spec.textarea_type || "small").toLowerCase();
        const sizes: Record<string, number> = { small: 2000, large: 32000, rich_text: 50000 };
        if (!(t in sizes)) return json({ error: "Text area size must be small, large or rich_text." }, 400);
        field.textarea = { type: t };
        field.length = sizes[t];
      }

      if (dataType === "picklist" || dataType === "multiselectpicklist") {
        const raw = Array.isArray(spec.picklist_values) ? spec.picklist_values : [];
        const seen = new Set<string>();
        const values: any[] = [];
        for (const v of raw) {
          const display = String(typeof v === "string" ? v : v?.display_value || "").trim();
          if (!display) continue;
          const key = display.toLowerCase();
          if (seen.has(key)) continue;   // Zoho rejects the whole call on a dupe
          seen.add(key);
          values.push({ display_value: display, actual_value: display });
        }
        if (!values.length) return json({ error: "A picklist needs at least one option." }, 400);
        if (values.length > 200) return json({ error: "That's more than 200 options — trim the list." }, 400);
        field.pick_list_values = values;
        if (raw.length !== values.length) notes.push("Blank or duplicate options were dropped.");
      }

      if (dataType === "currency") {
        const dp = Number(spec.decimal_place);
        const decimal = Number.isFinite(dp) ? Math.round(dp) : 2;
        if (decimal < 0 || decimal > 9) return json({ error: "Decimal places must be 0–9." }, 400);
        const pr = Number(spec.precision);
        const precision = Number.isFinite(pr) ? Math.round(pr) : Math.max(0, decimal - 1);
        if (precision >= decimal)
          return json({ error: "Zoho requires precision to be LESS than decimal places." }, 400);
        field.decimal_place = decimal;
        field.currency = { rounding_option: String(spec.rounding_option || "normal"), precision };
      }

      if (dataType === "double") {
        const dp = Number(spec.decimal_place);
        const decimal = Number.isFinite(dp) ? Math.round(dp) : 2;
        if (decimal < 0 || decimal > 9) return json({ error: "Decimal places must be 0–9." }, 400);
        field.decimal_place = decimal;
      }

      // Tooltip: picklist, date, datetime and currency accept only the info
      // icon. Sending static_text on those is a 400 from Zoho, so coerce rather
      // than let a dropdown choice nobody thinks about fail the whole create.
      const tip = String(spec.tooltip || "").trim();
      if (tip) {
        const iconOnly = ["picklist", "multiselectpicklist", "date", "datetime", "currency"].includes(dataType);
        const name = iconOnly ? "info_icon" : "static_text";
        const cap = name === "static_text" ? 35 : 255;
        field.tooltip = { name, value: tip.slice(0, cap) };
        if (tip.length > cap) notes.push(`Tooltip was trimmed to ${cap} characters.`);
      }

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      // Read the module's current fields: this is both the duplicate check and
      // the "how much room is left" count, and it doubles as a scope probe --
      // if settings can't even be READ, creating was never going to work.
      const listUrl = new URL(`https://${apiDomain}/crm/v6/settings/fields`);
      listUrl.searchParams.set("module", moduleName);
      const listRes = await zohoFetch(sb, conn, accessToken, listUrl.toString(), {});
      const listData = listRes.status === 204 ? { fields: [] } : await listRes.json().catch(() => ({}));
      if (!listRes.ok) {
        return json({
          error: listData?.code === "OAUTH_SCOPE_MISMATCH"
            ? "This Zoho connection can't read module settings. Re-authorize it from the Zoho Connection card above."
            : (listData?.message || "Zoho wouldn't list that module's fields."),
          detail: listData,
        }, listRes.status);
      }
      const existing = Array.isArray(listData.fields) ? listData.fields : [];
      const norm = (s: unknown) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
      const clash = existing.find((f: any) => norm(f.field_label) === norm(label) || norm(f.api_name) === norm(label));
      const customCount = existing.filter((f: any) => f.custom_field).length;

      const preview = {
        module: moduleName,
        payload: { fields: [field] },
        existing_custom_fields: customCount,
        conflict: clash ? { field_label: clash.field_label, api_name: clash.api_name, data_type: clash.data_type } : null,
        notes,
      };

      // A name Zoho already uses is refused at BOTH steps, not just warned
      // about in the preview -- otherwise the confirm round-trip could still
      // post it and get a bare "duplicate" back from Zoho.
      if (clash) {
        return json({
          ...preview,
          error: `"${clash.field_label}" already exists on ${moduleName} (api name ${clash.api_name}). Pick a different label.`,
        }, 409);
      }

      if (body.confirm !== true) return json({ ...preview, created: false }, 200);

      const createRes = await zohoFetch(sb, conn, accessToken, listUrl.toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: [field] }),
      });
      const created = await createRes.json().catch(() => ({}));
      const row = created?.fields?.[0];
      if (!createRes.ok || row?.status !== "success") {
        const code = String(row?.code || created?.code || "");
        return json({
          ...preview,
          created: false,
          error: code === "OAUTH_SCOPE_MISMATCH"
            ? "This Zoho connection isn't allowed to create fields. Re-authorize it from the Zoho Connection card above — the scope line there includes what's needed."
            : (row?.message || created?.message || "Zoho refused to create the field."),
          detail: created,
        }, createRes.ok ? 400 : createRes.status);
      }

      // Zoho names the field, not us, and every later query has to use that
      // api_name -- so read it back rather than leaving the admin to guess how
      // "Deal Temperature" was mangled.
      const newId = row?.details?.id || null;
      let apiName: string | null = null;
      try {
        const reRes = await zohoFetch(sb, conn, accessToken, listUrl.toString(), {});
        const reData = reRes.status === 204 ? { fields: [] } : await reRes.json().catch(() => ({}));
        const found = (reData.fields || []).find((f: any) => String(f.id) === String(newId));
        apiName = found?.api_name || null;
      } catch { /* the field exists either way; the api_name is a convenience */ }

      return json({
        ...preview,
        created: true,
        id: newId,
        api_name: apiName,
        message: `Created "${label}" on ${moduleName}.`,
      }, 200);
    }

    // ── Fuzzy-match a typed name against Contacts [KPI resolver] ─────
    if (action === "match_contacts") {
      const name = (body.name || "").trim();
      if (!name) return json({ matches: [] }, 200);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      // Search by each spelled-out token (Zoho word-search), collect + dedupe candidates.
      const tokens = name.toLowerCase().split(/\s+/).filter((t: string) => t.length >= 2);
      const byId: Record<string, any> = {};
      for (const tok of tokens) {
        const u = new URL(`https://${apiDomain}/crm/v6/Contacts/search`);
        u.searchParams.set("word", tok);
        u.searchParams.set("per_page", "20");
        const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
        if (r.status === 204) continue;
        const dt = await r.json().catch(() => ({}));
        for (const c of dt.data || []) {
          const full =
            c.Full_Name || `${c.First_Name || ""} ${c.Last_Name || ""}`.trim();
          byId[c.id] = { id: c.id, full_name: full, email: c.Email || null };
        }
      }
      const matches = Object.values(byId)
        .map((c: any) => ({ ...c, score: Math.round(nameScore(name, c.full_name) * 100) }))
        .sort((a: any, b: any) => b.score - a.score)
        .slice(0, 5);

      return json({ query: name, matches }, 200);
    }

    // ── Create a new Contact [KPI resolver] ─────────────────────────
    if (action === "create_contact") {
      const first = (body.first_name || "").trim();
      const last = (body.last_name || "").trim();
      if (!last) return json({ error: "Last name is required to create a contact." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      const rec: any = { Last_Name: last };
      if (first) rec.First_Name = first;
      // Same reason as create_record: an Owner-less contact becomes the API
      // connection owner's.
      {
        const oe = typeof body.owner_email === "string" ? body.owner_email.trim() : "";
        const { owner } = await ownerForCaller(sb, conn, accessToken, apiDomain, auth, oe);
        if (owner) rec.Owner = owner;
      }
      const r = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Contacts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [rec] }),
      });
      const dt = await r.json().catch(() => ({}));
      const created = dt?.data?.[0];
      if (!r.ok || created?.status !== "success") {
        return json(
          { error: created?.message || dt?.message || "Could not create contact", detail: dt },
          r.ok ? 400 : r.status
        );
      }
      return json(
        { ok: true, id: created?.details?.id || null, full_name: `${first} ${last}`.trim() },
        200
      );
    }

    // ── Create a record in any module [write] ──────────────────────
    // ── A record's own change history [read-only] ──────────────────
    //  Zoho keeps an audit trail per record, including the BEFORE and AFTER of
    //  every field edit. It is the only way to recover a value the app itself
    //  overwrote, because nothing client-side stores the previous one.
    if (action === "record_timeline") {
      const moduleName = (body.module || "Tasks").trim().replace(/[^A-Za-z0-9_]/g, "");
      const ids = Array.isArray(body.ids) ? body.ids.filter(Boolean).slice(0, 60) : [];
      if (!ids.length) return json({ timelines: {} }, 200);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const out: Record<string, any> = {};
      const B = 6;
      for (let i = 0; i < ids.length; i += B) {
        const batch = ids.slice(i, i + B);
        const res = await Promise.all(batch.map(async (id: string) => {
          try {
            const r = await zohoFetch(sb, conn, accessToken,
              `https://${apiDomain}/crm/v6/${moduleName}/${id}/__timeline?per_page=50`, {});
            if (r.status === 204) return [id, []];
            const d = await r.json().catch(() => ({}));
            if (!r.ok) return [id, { error: d?.message || `HTTP ${r.status}`, detail: d }];
            return [id, d.__timeline || d.timeline || []];
          } catch (e) { return [id, { error: String(e) }]; }
        }));
        for (const [id, v] of res) out[id as string] = v;
      }
      return json({ timelines: out }, 200);
    }

    if (action === "create_record") {
      const moduleName = (body.module || "Tasks").trim();
      const record = body.record;
      if (!record || typeof record !== "object" || !Object.keys(record).length)
        return json({ error: "Missing record." }, 400);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      // This is the app's general-purpose write door — new Contacts and every
      // task from the CRM drawer come through here — and it used to post the
      // record exactly as the browser sent it. Anything that forgot an Owner
      // was silently filed under the API connection owner, which is the
      // "assigned to Symon again" report.
      //
      // A client-supplied Owner WINS, and is only filled in when absent. That
      // ordering is deliberate: the Calls tab lets an admin log work on behalf
      // of a chosen agent and sends that agent's Zoho id, which is more
      // specific than the session. Overriding it would silently re-file every
      // on-behalf-of entry under the admin, and deleting it when resolution
      // failed would be worse than doing nothing at all.
      //
      // The spoofing trade-off is accepted knowingly: this is an internal team
      // app where logging for a teammate is a real workflow, not a threat.
      const ownerEmail = typeof body.owner_email === "string" ? body.owner_email.trim() : "";
      let warning: string | null = null;
      if (!record.Owner) {
        const r = await ownerForCaller(sb, conn, accessToken, apiDomain, auth, ownerEmail);
        if (r.owner) record.Owner = r.owner;
        warning = r.warning;
      }

      const r = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/${moduleName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [record] }),
      });
      const d = await r.json().catch(() => ({}));
      const row = d?.data?.[0];
      if (!r.ok || row?.status !== "success")
        return json({ error: row?.message || d?.message || "Could not create record", detail: d }, r.ok ? 400 : r.status);
      const newId = row?.details?.id || null;
      await stampSubmission(sb, moduleName, newId, auth.userId, null);
      return json({ ok: true, id: newId, owner_warning: warning }, 200);
    }

    // ── Update a record in any module [write] ───────────────────────
    if (action === "update_record") {
      const moduleName = (body.module || "Tasks").trim();
      const id = (body.id || "").toString().trim();
      const record = body.record;
      if (!id) return json({ error: "Missing record id." }, 400);
      if (!record || typeof record !== "object" || !Object.keys(record).length)
        return json({ error: "Missing fields to update." }, 400);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const r = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/${moduleName}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [{ id, ...record }] }),
      });
      const d = await r.json().catch(() => ({}));
      const row = d?.data?.[0];
      if (!r.ok || row?.status !== "success")
        return json({ error: row?.message || d?.message || "Could not update record", detail: d }, r.ok ? 400 : r.status);
      return json({ ok: true, id }, 200);
    }

    // ── Delete a record in any module [write] ───────────────────────
    if (action === "delete_record") {
      const moduleName = (body.module || "Tasks").trim();
      const id = (body.id || "").toString().trim();
      if (!id) return json({ error: "Missing record id." }, 400);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const u = new URL(`https://${apiDomain}/crm/v6/${moduleName}`);
      u.searchParams.set("ids", id);
      const r = await zohoFetch(sb, conn, accessToken, u.toString(), {
        method: "DELETE",
      });
      const d = await r.json().catch(() => ({}));
      const row = d?.data?.[0];
      if (!r.ok || row?.status !== "success")
        return json({ error: row?.message || d?.message || "Could not delete record", detail: d }, r.ok ? 400 : r.status);
      return json({ ok: true, id }, 200);
    }

    // ── List Tasks (native Tasks/Activities module) [read-only] ────
    //  GET /crm/v6/Tasks with paging + sort. `fields` is required by Zoho;
    //  the caller passes the resolved api-names (incl. custom fields it
    //  discovered via get_fields). Returns raw records + paging info.
    //
    //  Zoho's plain `page` param only works up to page*per_page = 2000 —
    //  requesting page 11+ silently returns nothing, even when `more_records`
    //  was true on page 10. Past that point Zoho requires continuing via the
    //  opaque `page_token` it returns in `info.next_page_token` instead of a
    //  page number. So: page 1 uses `page`; once the caller has a page_token
    //  (from a prior response), pass that instead and drop `page` entirely.
    if (action === "list_tasks") {
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const moduleName = (body.module || "Tasks").trim();

      const per = Math.min(parseInt(body.per_page, 10) || 100, 200);
      const page = Math.max(parseInt(body.page, 10) || 1, 1);
      const pageToken = typeof body.page_token === "string" && body.page_token ? body.page_token : null;
      // status_not: excludes one status (e.g. "Completed") so the default view can stay to
      // OPEN tasks only — with 20k+ historical tasks in this org, loading everything on every
      // page visit is a ~100-call, 90+ second fetch. Uses the Search Records API (same one
      // search_tasks already uses) since the plain list endpoint has no criteria filtering.
      const statusNot = typeof body.status_not === "string" && body.status_not ? body.status_not : null;
      // owner_id: narrow the pull to ONE Zoho user, server-side. Owner cannot be
      // filtered by NAME without the ZohoCRM.users.READ scope this org's grant
      // does not have — but every task record carries Owner.id, so the caller can
      // learn its own id from its own tasks and pass it here. Worth doing for two
      // reasons beyond speed: it keeps a per-agent pull well under Zoho's ~2,000
      // record paging ceiling (past which a month silently goes incomplete), and
      // it stops the whole team's calls being shipped to one agent's browser.
      // Digits only — the value goes straight into a criteria string.
      const ownerId = /^[0-9]{1,32}$/.test(String(body.owner_id || "")) ? String(body.owner_id) : null;
      const fields =
        Array.isArray(body.fields) && body.fields.length
          ? body.fields.filter(Boolean).join(",")
          : "Owner,Subject,Status,Due_Date,Closed_Time,Description,Who_Id,What_Id,Priority";

      // Criteria filtering only exists on the Search endpoint, so any filter at
      // all forces that path.
      const useSearch = !!(statusNot || ownerId);
      const base = useSearch
        ? `https://${apiDomain}/crm/v6/${moduleName}/search`
        : `https://${apiDomain}/crm/v6/${moduleName}`;
      const url = new URL(base);
      url.searchParams.set("fields", fields);
      url.searchParams.set("per_page", String(per));
      if (useSearch) {
        const crit: string[] = [];
        if (statusNot) crit.push(`(Status:not_equal:${String(statusNot).replace(/[()]/g, "").slice(0, 80)})`);
        if (ownerId) crit.push(`(Owner:equals:${ownerId})`);
        url.searchParams.set("criteria", crit.length > 1 ? "(" + crit.join("and") + ")" : crit[0]);
      }
      if (pageToken) url.searchParams.set("page_token", pageToken);
      else url.searchParams.set("page", String(page));
      if (body.sort_by) {
        url.searchParams.set("sort_by", String(body.sort_by));
        url.searchParams.set("sort_order", body.sort_order === "asc" ? "asc" : "desc");
      }

      const crmRes = await zohoFetch(sb, conn, accessToken, url.toString(), {});
      if (crmRes.status === 204) return json({ tasks: [], info: { more_records: false } }, 200);
      const crmData = await crmRes.json().catch(() => ({}));
      if (!crmRes.ok)
        return json({ error: crmData?.message || "Zoho tasks error", detail: crmData }, crmRes.status);

      return json({ tasks: crmData.data || [], info: crmData.info || {} }, 200);
    }

    // ── Search Tasks across the whole org [read-only] ──────────────
    //  Lets the AI answer about tasks BEYOND the loaded view (all overdue,
    //  a person's tasks, a date range). Uses the Search Records API with
    //  `criteria` — NOT COQL: COQL needs a separate ZohoCRM.coql.READ scope
    //  this token lacks, whereas /search is covered by ZohoCRM.modules.ALL
    //  (same API the contact resolver already uses live). Owner can't be
    //  filtered by name server-side without a user-id lookup, so we match
    //  Owner.name on the returned page (per_page bumped to 200 when an owner
    //  is requested). All values are whitelisted/validated.
    if (action === "search_tasks") {
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const moduleName = "Tasks";
      const dateOk = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const val = (v: any) => String(v == null ? "" : v).replace(/[()]/g, "").slice(0, 80); // criteria values cannot contain parentheses
      const apiName = (v: any) => String(v || "").replace(/[^A-Za-z0-9_]/g, "");
      const typeField = body.type_field ? apiName(body.type_field) : "";

      const crit: string[] = [];
      if (body.status) crit.push(`(Status:equals:${val(body.status)})`);
      if (body.status_not) crit.push(`(Status:not_equal:${val(body.status_not)})`);
      if (body.due_before && dateOk(body.due_before)) crit.push(`(Due_Date:less_than:${body.due_before})`);
      if (body.due_after && dateOk(body.due_after)) crit.push(`(Due_Date:greater_than:${body.due_after})`);
      if (body.due_on && dateOk(body.due_on)) crit.push(`(Due_Date:equals:${body.due_on})`);
      if (body.type && typeField) crit.push(`(${typeField}:equals:${val(body.type)})`);
      // Search API requires a criteria; this default matches every task (no task has that status).
      const criteria = crit.length ? (crit.length > 1 ? "(" + crit.join("and") + ")" : crit[0]) : "(Status:not_equal:__ZZZ_NONE__)";

      // extra_fields: any other Tasks field api-names the client wants back (e.g. Description,
      // Trigger, and whatever org-specific custom fields it discovered via get_fields) — so the
      // AI isn't blind to fields beyond this fixed baseline.
      const extraFields = Array.isArray(body.extra_fields)
        ? body.extra_fields.map(apiName).filter(Boolean)
        : [];
      const fields = Array.from(new Set(
        ["Owner", "Subject", "Status", "Due_Date", "Closed_Time", "Description", "Who_Id", typeField, ...extraFields].filter(Boolean)
      ));
      const per = Math.min(parseInt(body.per_page, 10) || 100, 200);

      const u = new URL(`https://${apiDomain}/crm/v6/${moduleName}/search`);
      u.searchParams.set("criteria", criteria);
      u.searchParams.set("fields", fields.join(","));
      u.searchParams.set("per_page", String(body.owner ? 200 : per));

      const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
      if (r.status === 204) return json({ tasks: [] }, 200);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.message || "Zoho search error", detail: d }, r.status);

      let tasks = d.data || [];
      if (body.owner) {
        const o = String(body.owner).toLowerCase();
        tasks = tasks.filter((t: any) => (t.Owner?.name || "").toLowerCase().includes(o));
      }
      return json({ tasks, info: d.info || {} }, 200);
    }

    // ── Get a single contact's details by id or name [read-only] ────
    if (action === "get_contact") {
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      // Other_Phone matters: the Cadence Health "unreachable" sweep counts it as
      // a number, so leaving it out here made the two disagree — a contact with
      // only an Other_Phone looked numberless to the call row.
      //
      // Client_Classification is the contact's REAL A/B/C tier. The call row
      // used to regex it off the task subject, so a contact classified A in
      // Zoho read "No class" whenever the subject didn't literally say
      // "A Touch Call". Owner rides along because the contact summary has to
      // resolve the owning agent FROM THE RECORD, never from the caller.
      const baseFields = "First_Name,Last_Name,Full_Name,Email,Phone,Mobile,Other_Phone," +
        "Mailing_City,Mailing_State,Lead_Source,Created_Time,Client_Classification,Owner";
      // Extra api-names the caller discovered live off settings/fields (today
      // only the prospect-form field). Sanitised the way spouse_field is, and
      // capped so a caller can't build an unbounded URL.
      const extra: string[] = (Array.isArray(body.extra_fields) ? body.extra_fields : [])
        .map((f: any) => String(f).replace(/[^A-Za-z0-9_]/g, ""))
        .filter(Boolean).slice(0, 5);

      let id = (body.id || "").toString().trim();
      if (!id && body.name) {
        const u = new URL(`https://${apiDomain}/crm/v6/Contacts/search`);
        u.searchParams.set("word", String(body.name).trim());
        u.searchParams.set("per_page", "1");
        const sr = await zohoFetch(sb, conn, accessToken, u.toString(), {});
        if (sr.status !== 204) { const sd = await sr.json().catch(() => ({})); id = sd?.data?.[0]?.id || ""; }
      }
      if (!id) return json({ contact: null, found: false }, 200);

      // Zoho rejects the WHOLE record GET with 400 INVALID_QUERY_PARAM if any
      // single name in ?fields= is wrong for the module. The extras are
      // discovered by matching a field LABEL, so a bad guess there would take
      // the phone number, the email and the spouse fallback down with it — the
      // Calls tab's primary data — for every contact on the list. So the extras
      // are asked for once, and a 400 retries WITHOUT them rather than failing.
      const getWith = (list: string) =>
        zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Contacts/${id}?fields=${encodeURIComponent(list)}`, {});

      // Tags ride in the same risky group. "Tag" is a system field and should
      // always be valid, but ?fields= is all-or-nothing, so it goes behind the
      // retry rather than into baseFields where a wrong guess would take the
      // phone number down with it for every contact on the list.
      const risky = extra.concat(["Tag"]);
      let extraFailed = false;
      let r = await getWith(baseFields + "," + risky.join(","));
      if (!r.ok && r.status === 400) {
        extraFailed = true;
        // Drain the rejected response before dropping it — an unread body
        // keeps its connection open.
        try { await r.body?.cancel(); } catch { /* already drained */ }
        r = await getWith(baseFields);
      }
      if (r.status === 204) return json({ contact: null, found: false }, 200);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.message || "Zoho contact error" }, r.status);
      const c = d?.data?.[0];
      if (!c) return json({ contact: null, found: false }, 200);
      const cls = String(c.Client_Classification ?? "").trim();
      return json({ found: true, contact: {
        id: c.id,
        full_name: c.Full_Name || `${c.First_Name || ""} ${c.Last_Name || ""}`.trim(),
        email: c.Email || null, phone: c.Phone || c.Mobile || c.Other_Phone || null,
        city: c.Mailing_City || null, state: c.Mailing_State || null,
        lead_source: c.Lead_Source || null, created: c.Created_Time || null,
        // null means NOT READ (the ask was dropped to save the phone number),
        // [] means read and this contact genuinely has no tags. The call row
        // shows chips for the second and nothing at all for the first —
        // conflating them would print "no tags" over a failed lookup.
        tags: extraFailed ? null : zohoTagNames(c.Tag),
        // Returned RAW, deliberately not gated to /^[ABC]$/. That gate is right
        // where this file BUILDS a task subject and must not emit garbage into
        // one; re-applying it here would rebuild the very bug being fixed —
        // a real Zoho value rendered as "No class".
        classification: (cls && !/^-?\s*none\s*-?$/i.test(cls)) ? cls : null,
        owner: c.Owner ? { id: c.Owner.id || null, name: c.Owner.name || null } : null,
        // Only present when extras were asked for, so today's callers keep a
        // byte-identical shape. `extra_failed` says the ask was DROPPED — which
        // must never be cached as "this contact has no value for that field".
        ...(extra.length ? {
          extra: extraFailed ? null : Object.fromEntries(extra.map(k => [k, (c as any)[k] ?? null])),
          extra_failed: extraFailed,
        } : {}),
      } }, 200);
    }

    // ── Everything the contact summary needs, in one round trip [read-only] ──
    //  The (i) on a call row opens a short brief. Gathering it as three separate
    //  browser round trips would be three chances to half-fail; this returns the
    //  contact, their spouse, their open deals and their recent call history
    //  together, and says explicitly which parts it could not read rather than
    //  returning a confident empty list.
    //
    //  Read-only and deliberately narrow: no Description (it runs to pages and
    //  is the shape of the $20 incident), no email bodies, nothing written.
    if (action === "contact_facts") {
      const cid = String(body.contact_id || "").trim();
      if (!/^\d+$/.test(cid)) return json({ error: "bad_contact_id" }, 400);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      const CF_DEALS = 5;   // open deals are rare; 5 is already generous
      // Five pages of ten. Enough to show a real correspondence history without
      // letting one pathological record walk a hundred pages of newsletters.
      const CF_EMAIL_PAGES = 5;
      const CF_TASKS = 25;  // headroom: past and future tasks are split apart downstream,
                            // and a contact with several appointments booked can otherwise
                            // fill the whole window with things that have not happened yet.

      const contactFields = "First_Name,Last_Name,Full_Name,Email,Phone,Mobile,Other_Phone," +
        "Mailing_City,Mailing_State,Lead_Source,Created_Time,Client_Classification,Owner";

      // Deals and tasks are best-effort: a contact with neither is completely
      // normal, and a related list this connection cannot read must not sink
      // the whole brief. `deals_read` / `tasks_read` say which happened.
      const related = async (list: string, fields: string, per: number) => {
        try {
          const rr = await zohoFetch(sb, conn, accessToken,
            `https://${apiDomain}/crm/v6/Contacts/${cid}/${list}?fields=${encodeURIComponent(fields)}&per_page=${per}`, {});
          if (rr.status === 204) return { ok: true, rows: [] as any[] };
          if (!rr.ok) return { ok: false, rows: [] as any[] };
          const rd = await rr.json().catch(() => ({}));
          return { ok: true, rows: (rd.data || []) as any[] };
        } catch { return { ok: false, rows: [] as any[] }; }
      };

      // All three Zoho reads at once. They used to run contact-then-related,
      // three round trips deep, for calls that never look at each other.
      //
      // The contact's Response is carried through UNPARSED on purpose. Calling
      // .json() inside the settle would flatten a 204 and a 500 into the same
      // empty object, and a Zoho outage would then reach the agent as a
      // dead-end "Zoho no longer has this contact" instead of a retryable one.
      //
      // The cost of doing this eagerly: a contact id that no longer exists
      // still spends two related-list calls. That path is rare, and the hourly
      // ceiling in google-calendar caps how often it can be provoked.
      // Task_Type is what the brief needs to say "a note on 21 June and a call
      // on 21 June" rather than lumping every touch together. This org writes
      // Task_Type directly when it logs a KPI (see the kpi action above), so it
      // is asked for optimistically — and if some other org's api name differs,
      // the related list is re-read WITHOUT it rather than losing the call
      // history entirely to one bad field name.
      const TASK_FIELDS = "Subject,Status,Due_Date,Closed_Time";
      const tasksWithType = async () => {
        const withType = await related("Tasks", TASK_FIELDS + ",Task_Type", CF_TASKS);
        if (withType.ok) return { ...withType, typeRead: true };
        return { ...(await related("Tasks", TASK_FIELDS, CF_TASKS)), typeRead: false };
      };

      // Tag goes behind its own 400 retry for the same reason it does in
      // get_contact: ?fields= is all-or-nothing, and an unguarded bad name here
      // would turn every brief into "Zoho didn't answer".
      const contactGet = async () => {
        const get = (f: string) => zohoFetch(sb, conn, accessToken,
          `https://${apiDomain}/crm/v6/Contacts/${cid}?fields=${encodeURIComponent(f)}`, {});
        const withTag = await get(contactFields + ",Tag");
        if (withTag.status !== 400) return { res: withTag, tagsRead: true };
        // The rejected response's body is never read on this path. Dropping a
        // Response without draining it holds its connection open in Deno.
        try { await withTag.body?.cancel(); } catch { /* already drained */ }
        return { res: await get(contactFields), tagsRead: false };
      };

      // The Emails related list on the contact — the one an agent SEES in Zoho
      // under a contact's profile, holding mail synced in over IMAP from each
      // agent's own mailbox.
      //
      // This is why the July newsletter was missing from every brief. It was
      // BCC'd, so a Gmail `to:` search could never match it, and the app had no
      // other place to look. Zoho had it the whole time, on the record.
      //
      // Deliberately NOT the generic related-records endpoint: Zoho's related
      // list metadata gives Emails `"href": null`, meaning /Contacts/{id}/Emails
      // is a dedicated API with its own OAuth scope (ZohoCRM.modules.emails.READ,
      // required IN ADDITION to the module scopes this app already holds). No
      // `type` param on purpose — the default is "all emails from the users and
      // the ones sent from CRM", which is the widest view this connection has.
      // Ten per call is the documented hard ceiling; there is no per_page.
      //
      // Every failure mode is NAMED rather than collapsed into "couldn't read".
      // "The connection was never granted email access" and "the agent keeps
      // their Zoho mail private" need two completely different fixes, and a
      // brief that says only "no emails" sends the agent into a call believing
      // a newsletter never went out.
      const emailsGet = async (): Promise<{ state: string; rows: any[] }> => {
        // Ten per call is the ceiling and there is no per_page. This list does
        // NOT paginate with `page` — it hands back an opaque `info.next_index`
        // cursor which the next call passes as `index`. The earlier `page=N`
        // loop was silently a no-op: Zoho ignored the param, returned the same
        // newest ten every time, and the duplicate guard stopped the loop on
        // round two. Every contact was therefore capped at ten emails, which
        // is exactly the "why is it just one email" complaint, one order of
        // magnitude up.
        const rows: any[] = [];
        const seen = new Set<string>();
        let index: string | null = null;
        for (let page = 1; page <= CF_EMAIL_PAGES; page++) {
          try {
            const r = await zohoFetch(sb, conn, accessToken,
              `https://${apiDomain}/crm/v6/Contacts/${cid}/Emails${index ? `?index=${encodeURIComponent(index)}` : ""}`, {});
            if (r.status === 204) return { state: rows.length ? "read" : "none", rows };
            const d = await r.json().catch(() => ({}));
            if (!r.ok) {
              if (rows.length) return { state: "read", rows };   // keep what page 1 gave us
              const code0 = String(d?.code || "");
              if (code0 === "OAUTH_SCOPE_MISMATCH") return { state: "no_scope", rows: [] };
              if (code0 === "NO_PERMISSION") return { state: "not_shared", rows: [] };
              if (code0 === "CANNOT_PROCESS") return { state: "not_synced", rows: [] };
              return { state: "failed", rows: [] };
            }
            const got = Array.isArray(d?.Emails) ? d.Emails : [];
            let fresh = 0;
            for (const m of got) {
              const key = String(m?.message_id || m?.id || JSON.stringify(m).slice(0, 120));
              if (seen.has(key)) continue;
              seen.add(key); rows.push(m); fresh++;
            }
            // `more_records` is the server's own word for whether another page
            // exists. The duplicate guard stays as a backstop in case the
            // cursor ever loops, but it is no longer what ends the walk.
            const info = d?.info || {};
            index = (info.more_records === true && info.next_index) ? String(info.next_index) : null;
            if (!got.length || !fresh || !index) break;
          } catch { break; }
        }
        return { state: "read", rows };
      };

      const [contactRes, dealsRes, tasksRes, emailsRes] = await Promise.all([
        contactGet(),
        related("Deals", "Deal_Name,Stage,Amount,Closing_Date,Type,Owner", CF_DEALS),
        tasksWithType(),
        emailsGet(),
      ]);
      const cr = contactRes.res;
      if (cr.status === 204) return json({ found: false }, 200);
      if (!cr.ok) return json({ error: "zoho_unavailable", retryable: true }, 502);
      const cd = await cr.json().catch(() => ({}));
      const c = cd?.data?.[0];
      if (!c) return json({ found: false }, 200);

      const clsRaw = String(c.Client_Classification ?? "").trim();
      // Newest first. Zoho returns the related list in its own order, and the
      // brief only cares about the most recent touches.
      const stamp = (t: any) => String(t.Closed_Time || t.Due_Date || "");
      const tasks = tasksRes.rows.slice()
        .sort((a: any, b: any) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0))
        .slice(0, CF_TASKS);
      return json({
        found: true,
        contact: {
          id: c.id,
          full_name: c.Full_Name || `${c.First_Name || ""} ${c.Last_Name || ""}`.trim(),
          email: c.Email || null,
          city: c.Mailing_City || null, state: c.Mailing_State || null,
          lead_source: c.Lead_Source || null, created: c.Created_Time || null,
          classification: (clsRaw && !/^-?\s*none\s*-?$/i.test(clsRaw)) ? clsRaw : null,
          owner: c.Owner ? { id: c.Owner.id || null, name: c.Owner.name || null } : null,
          // null means the Tag ask was dropped to save the rest of the record;
          // [] means it was read and this contact genuinely has no tags.
          tags: contactRes.tagsRead ? zohoTagNames(c.Tag) : null,
        },
        deals: dealsRes.rows.map((d: any) => ({
          name: d.Deal_Name || null,
          stage: d.Stage || null,
          amount: d.Amount ?? null,
          closing_date: d.Closing_Date || null,
          type: d.Type || null,
        })),
        deals_read: dealsRes.ok,
        tasks: tasks.map((t: any) => ({
          subject: t.Subject || null,
          status: t.Status || null,
          due: t.Due_Date || null,
          closed: t.Closed_Time || null,
          // "Call", "Note", "Email"… The brief lists the newest touch of each
          // type, so the type matters more here than the subject line.
          type: t.Task_Type || null,
        })),
        // Subject, direction and date only — no body, and the body would cost a
        // second API call per message anyway (Zoho only returns content from
        // the single-email endpoint). Newest first, same as tasks.
        emails: emailsRes.rows.map((m: any) => ({
          // Zoho's own id for the message. The only handle a deep link can use.
          id: m.message_id || m.id || null,
          subject: m.subject || null,
          from: (m.from && (m.from.user_name || m.from.email)) || null,
          to: Array.isArray(m.to) ? m.to.map((t: any) => t.user_name || t.email).filter(Boolean).slice(0, 4) : [],
          time: m.time || null,
          // `sent` true = went out from the org; false = arrived from them.
          sent: m.sent === true,
          status: Array.isArray(m.status) && m.status[0] ? (m.status[0].type || null) : null,
          owner: (m.owner && m.owner.name) || null,
        })).sort((a: any, b: any) => (String(a.time) < String(b.time) ? 1 : String(a.time) > String(b.time) ? -1 : 0)),
        // read · none · no_scope · not_shared · not_synced · failed.
        // The brief turns each into a sentence that names the actual fix.
        emails_state: emailsRes.state,
        tasks_read: tasksRes.ok,
        // false means Task_Type was refused and every `type` above is null —
        // the brief then says nothing rather than claiming there were no calls.
        tasks_type_read: tasksRes.typeRead,
      }, 200);
    }

    // ── Resolve each contact's spouse (lookup) [read-only] ─────────
    //  For the given contact ids, returns each one's Spouse contact {id,name}
    //  (or null). The Tasks AI uses this to pair up married contacts and
    //  compare their task due dates. Parallel-batched + capped to stay fast.
    if (action === "spouse_links") {
      const ids = Array.isArray(body.contact_ids) ? body.contact_ids.filter(Boolean).slice(0, 60) : [];
      if (!ids.length) return json({ links: {} }, 200);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      // Find the Spouse lookup field's api name on Contacts (or take it from the caller).
      //
      // "We could not read the field list" and "this org has no Spouse field"
      // used to collapse into the SAME 200 + empty-links answer, and callers
      // cache a null spouse permanently. One transient Zoho hiccup on this
      // single metadata read therefore branded up to 60 contacts as having no
      // spouse forever — which, since a contact with no phone of their own is
      // reached through their spouse, left them permanently uncallable. The two
      // cases are now told apart: a failed read is a 502 the caller retries, an
      // org genuinely without the field keeps the 200.
      let spouseApi = (body.spouse_field || "").toString().replace(/[^A-Za-z0-9_]/g, "");
      if (!spouseApi) {
        const fr = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/settings/fields?module=Contacts`, {});
        if (!fr.ok) return json({ error: "Could not read the Contacts field list from Zoho.", retryable: true }, 502);
        const fd = await fr.json().catch(() => ({}));
        const f = (fd.fields || []).find((x: any) => /spouse|partner/i.test(x.field_label || "") && x.data_type === "lookup");
        spouseApi = f?.api_name || "";
      }
      if (!spouseApi) return json({ no_spouse_field: true, links: {} }, 200);

      const links: Record<string, any> = {};
      const B = 10;
      for (let i = 0; i < ids.length; i += B) {
        const batch = ids.slice(i, i + B);
        const res = await Promise.all(batch.map(async (id: string) => {
          try {
            const r = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Contacts/${id}?fields=${spouseApi}`, {});
            // undefined = could not read this one. null = read fine, no spouse.
            // Returning null for both is what let a failed read be cached as a
            // definitive "they have no spouse".
            if (!r.ok) return [id, undefined];
            const d = await r.json().catch(() => ({}));
            const sp = d?.data?.[0]?.[spouseApi];
            return [id, sp && sp.id ? { id: sp.id, name: sp.name || null } : null];
          } catch { return [id, undefined]; }
        }));
        // Ids we could not read are OMITTED from links entirely, so the caller
        // can tell "asked and there is none" from "never got an answer".
        for (const [id, sp] of res) { if (sp !== undefined) links[id as string] = sp; }
      }
      return json({ field: spouseApi, links, asked: ids }, 200);
    }

    // ── Tasks for a set of contacts [read-only] ────────────────────
    //  Returns each contact's related Tasks via the Get Related Records
    //  endpoint (modules scope; COQL/search-by-lookup need scopes we lack).
    //  Powers the spouse audit (fetch a spouse's task that's outside the
    //  loaded view) and the "last completed call" check. Parallel-batched.
    if (action === "tasks_for_contacts") {
      const ids = Array.isArray(body.contact_ids) ? body.contact_ids.filter(Boolean).slice(0, 60) : [];
      if (!ids.length) return json({ tasks_by_contact: {} }, 200);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const typeField = (body.type_field || "").toString().replace(/[^A-Za-z0-9_]/g, "");
      const relatedList = ((body.related_list || "Tasks").toString().replace(/[^A-Za-z0-9_]/g, "")) || "Tasks";
      const fields = ["Subject", "Status", "Due_Date", "Closed_Time", "Who_Id", typeField].filter(Boolean).join(",");

      const out: Record<string, any> = {};
      const owners: Record<string, any> = {};
      const B = 8;
      for (let i = 0; i < ids.length; i += B) {
        const batch = ids.slice(i, i + B);
        const res = await Promise.all(batch.map(async (id: string) => {
          try {
            const [tr, cr] = await Promise.all([
              zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Contacts/${id}/${relatedList}?fields=${encodeURIComponent(fields)}&per_page=50`, {}),
              zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Contacts/${id}?fields=Owner`, {}),
            ]);
            let tasks: any[] = [];
            if (tr.ok && tr.status !== 204) { const td = await tr.json().catch(() => ({})); tasks = td.data || []; }
            let owner: string | null = null;
            if (cr.ok && cr.status !== 204) { const cd = await cr.json().catch(() => ({})); owner = cd?.data?.[0]?.Owner?.name || null; }
            return [id, tasks, owner];
          } catch { return [id, [], null]; }
        }));
        for (const [id, tasks, owner] of res) { out[id as string] = tasks; owners[id as string] = owner; }
      }
      return json({ tasks_by_contact: out, owner_by_contact: owners }, 200);
    }

    // ── Delete every Task owned by one person [admin] ──────────────
    //  For a departed agent whose finished tasks keep surfacing in the Calls
    //  tab. This DESTROYS records: a deleted Zoho task stops being counted by
    //  Zoho Reports, which tallies the Tasks module by Task Type, so this also
    //  removes those calls from the org's KPI history. There is no undo.
    //
    //  Because of that, it is two trips, never one:
    //
    //    preview  ->  resolve the name against Zoho's user list, count what
    //                 that person actually owns, return a sample. Deletes
    //                 nothing.
    //    confirm  ->  the caller sends back the exact owner id AND the count
    //                 it was shown. If either no longer matches, nothing is
    //                 deleted.
    //
    //  That second check is the point. "Monty Shady" and "Monty Shaddy" are
    //  one keystroke apart, and a name that matched two users, or a count that
    //  moved between the preview and the confirm, means the operator is not
    //  looking at what they think they are looking at.
    if (action === "purge_owner_tasks") {
      if (!(auth as any).isService) {
        const { data: prof } = await sb.from("profiles").select("access").eq("id", auth.userId).maybeSingle();
        const roles = Array.isArray(prof?.access) ? prof.access : [];
        if (!roles.includes("admin")) return json({ error: "Admin access required." }, 403);
      }
      const nameQuery = String(body.owner_name || "").trim();
      const confirmId = String(body.confirm_owner_id || "").trim();
      const expected = Number.isFinite(Number(body.expected_count)) ? Number(body.expected_count) : null;
      if (!nameQuery && !confirmId) return json({ error: "Give a name to look for." }, 400);

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";

      // 1 — who is this. Matching against Zoho's own user list rather than
      //     free-typing an id means a typo yields "no such person", not a
      //     purge of somebody else's work.
      const ur = await zohoFetch(sb, conn, accessToken,
        `https://${apiDomain}/crm/v6/users?type=AllUsers&per_page=200`, {});
      if (!ur.ok) {
        const ud = await ur.json().catch(() => ({}));
        return json({
          error: String(ud?.code || "") === "OAUTH_SCOPE_MISMATCH"
            ? "This Zoho connection can’t read the user list, so the owner can’t be identified. Reconnect Zoho with users access."
            : "Couldn’t read the Zoho user list.",
        }, 400);
      }
      const ud = await ur.json().catch(() => ({}));
      const users = Array.isArray(ud?.users) ? ud.users : [];
      const norm = (v: unknown) => String(v || "").trim().toLowerCase();
      const matches = confirmId
        ? users.filter((u: any) => String(u.id) === confirmId)
        : users.filter((u: any) => norm(u.full_name).includes(norm(nameQuery)) || norm(u.email).includes(norm(nameQuery)));

      if (!matches.length)
        return json({ error: `Nobody in Zoho matches “${nameQuery || confirmId}”.`, owners: [] }, 404);
      // Ambiguity is never resolved here. Hand back the candidates and let a
      // person pick -- guessing which of two people to delete work from is not
      // a decision this endpoint gets to make.
      if (matches.length > 1)
        return json({
          error: "That matches more than one person in Zoho. Pick one.",
          owners: matches.map((u: any) => ({ id: String(u.id), name: u.full_name, email: u.email, status: u.status })),
        }, 409);

      const owner = matches[0];
      const ownerId = String(owner.id);

      // 2 — everything that person owns. One page at a time; Zoho caps a
      //     search page at 200 and the count is what the operator is about to
      //     destroy, so it is counted honestly rather than estimated.
      const PAGE = 200;
      const MAX_PAGES = 30;               // 6000 tasks; a stop, not a target
      const searchPage = async (page: number) => {
        const u = new URL(`https://${apiDomain}/crm/v6/Tasks/search`);
        u.searchParams.set("criteria", `(Owner:equals:${ownerId})`);
        u.searchParams.set("fields", "Owner,Subject,Status,Due_Date,Closed_Time");
        u.searchParams.set("per_page", String(PAGE));
        u.searchParams.set("page", String(page));
        const r = await zohoFetch(sb, conn, accessToken, u.toString(), {});
        if (r.status === 204) return { rows: [], more: false, ok: true };
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return { rows: [], more: false, ok: false, err: d?.message || "Zoho search error" };
        return { rows: Array.isArray(d.data) ? d.data : [], more: !!d?.info?.more_records, ok: true };
      };

      const all: any[] = [];
      let capped = false;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const r = await searchPage(page);
        if (!r.ok) return json({ error: r.err || "Zoho search error" }, 400);
        all.push(...r.rows);
        if (!r.more) break;
        if (page === MAX_PAGES) capped = true;
      }

      const ownerOut = { id: ownerId, name: owner.full_name, email: owner.email, status: owner.status };
      // 3 — the preview. Gated on the COUNT being absent, not on the id: the
      //     operator reaches this a second time after picking from a list of
      //     same-name people, and that second look must still be a look.
      //     Deleting is the branch that requires a count, and only that branch.
      if (expected === null) {
        return json({
          preview: true, owner: ownerOut, count: all.length, capped,
          sample: all.slice(0, 10).map((t: any) => ({
            subject: t.Subject || null,
            status: t.Status || null,
            due: t.Due_Date || null,
            closed: t.Closed_Time ? String(t.Closed_Time).slice(0, 10) : null,
          })),
        }, 200);
      }

      // 4 — the confirm. The count the operator was shown has to still be the
      //     count that is there, or we are deleting something they never saw.
      if (!confirmId)
        return json({ error: "Confirm with the owner id you were shown." }, 400);
      if (expected !== all.length)
        return json({
          error: `This changed since you looked — it was ${expected} tasks, now it’s ${all.length}. Nothing was deleted. Look again.`,
          owner: ownerOut, count: all.length,
        }, 409);
      if (!all.length) return json({ ok: true, owner: ownerOut, deleted: 0, failed: 0 }, 200);

      // Zoho takes up to 100 ids on one DELETE. Chunked, and every chunk's
      // per-record status is read -- a 200 on the call does not mean all 100
      // rows went.
      const ids = all.map((t: any) => String(t.id)).filter(Boolean);
      let deleted = 0;
      const failures: Array<{ id: string; message: string }> = [];
      for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const u = new URL(`https://${apiDomain}/crm/v6/Tasks`);
        u.searchParams.set("ids", chunk.join(","));
        u.searchParams.set("wf_trigger", "false");
        const r = await zohoFetch(sb, conn, accessToken, u.toString(), { method: "DELETE" });
        const d = await r.json().catch(() => ({}));
        const rows = Array.isArray(d?.data) ? d.data : [];
        if (!r.ok && !rows.length) {
          failures.push(...chunk.map((id) => ({ id, message: String(d?.message || `HTTP ${r.status}`) })));
          continue;
        }
        rows.forEach((row: any, j: number) => {
          if (row?.status === "success") deleted++;
          else failures.push({ id: String(row?.details?.id || chunk[j] || ""), message: String(row?.message || "refused") });
        });
      }

      return json({
        ok: true, owner: ownerOut, deleted, failed: failures.length,
        failures: failures.slice(0, 10), capped,
      }, 200);
    }

    // ── A contact's prospect-form fields, grouped [read-only] ──────
    //  TMG drives its prospect forms with a Zoho LAYOUT RULE: pick a Prospect
    //  Form Type and that type's fields appear. Zoho does not expose layout
    //  rules through any API version -- their own Kaizen #63 says "API support
    //  is currently not extended to these rules" -- so the mapping of type to
    //  fields cannot be read, only mirrored.
    //
    //  Mirroring it in code would be a lie with a shelf life: the day an admin
    //  edits the rule in Zoho, this silently shows the wrong fields and nothing
    //  reports it. So the mapping is DERIVED, two ways, and which one was used
    //  is always reported back:
    //
    //    section  -- the layout has a section whose name matches the type
    //                ("Residential Buyer"). That IS the rule's shape, read live
    //                from Zoho, so it stays correct on its own. Preferred.
    //    filled   -- no such section. Fall back to every custom field on the
    //                record that actually has a value. Not as clean, but it
    //                leans on the same truth the rule does: a buyer only has
    //                buyer fields filled in.
    //
    //  Nothing about a RECORD is cached and nothing is written. The org's field
    //  list and layout are cached for ten minutes -- see SCHEMA_CACHE.
    if (action === "prospect_form") {
      const cid = String(body.contact_id || "").trim();
      if (!cid) return json({ error: "Missing contact id." }, 400);
      // The Calls row already knows the form type from the chip it just drew.
      // Passing it saves an entire round trip to Zoho before we can even work
      // out which fields to ask for.
      const typeHint = Array.isArray(body.types)
        ? body.types.map((t: any) => String(t || "").trim()).filter(Boolean)
        : [];

      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const get = (u: string) => zohoFetch(sb, conn, accessToken, u, {});

      // 1 -- field metadata. Labels, types and picklist options; needed to
      //      render an editable form rather than a wall of text boxes.
      const fd = await cachedJson("fields:Contacts", async () => {
        const r = await get(`https://${apiDomain}/crm/v6/settings/fields?module=Contacts`);
        if (!r.ok) { try { await r.body?.cancel(); } catch { /* drained */ } return null; }
        return await r.json().catch(() => null);
      });
      if (!fd) return json({ error: "Couldn’t read the Contacts field list." }, 400);
      const allFields = Array.isArray(fd?.fields) ? fd.fields : [];
      const meta = new Map<string, any>();
      for (const f of allFields) if (f?.api_name) meta.set(f.api_name, f);

      const PROSPECT_LABEL = /(prospect.*(form|type))|((form|type).*prospect)/i;
      const pf = allFields.filter((f: any) => PROSPECT_LABEL.test(String(f.field_label || "")));
      const prospectApi = pf.length === 1 ? String(pf[0].api_name) : "";
      const prospectLabel = pf.length === 1 ? String(pf[0].field_label || "Prospect form") : "Prospect form";

      // 2 -- layout sections, WITH their column shape. This is the part Zoho
      //      will give us, and when the org's sections are named after the form
      //      types it reproduces the rule exactly, for free, forever.
      const ld = await cachedJson("layouts:Contacts", async () => {
        const r = await get(`https://${apiDomain}/crm/v6/settings/layouts?module=Contacts`);
        if (!r.ok) { try { await r.body?.cancel(); } catch { /* drained */ } return null; }
        return await r.json().catch(() => null);
      });
      const sections: Array<{ name: string; cols: number; fields: string[] }> = [];
      for (const lay of (Array.isArray(ld?.layouts) ? ld.layouts : [])) {
        for (const sec of (Array.isArray(lay?.sections) ? lay.sections : [])) {
          // Only the fields Zoho itself DRAWS on the record detail page.
          // `view_type.view === false` marks an input that exists for editing
          // but is replaced on the page by a read-only twin: First Name and
          // Last Name are both view:false because Full Name, view:true, stands
          // in for the pair. Keeping all three emits a field Zoho never shows
          // and pushes everything after it into the wrong cell — the real
          // reason the arrangement looked scrambled rather than merely
          // mis-ordered. `type: "unused"` is the Unused Fields tray, which
          // nobody has put on the layout at all.
          const raw = (Array.isArray(sec?.fields) ? sec.fields : []).slice()
            .filter((f: any) => f?.view_type?.view !== false && String(f?.type || "") !== "unused");
          // Zoho hands fields back in an order that is close to, but not
          // reliably, the order they are drawn in. sequence_number is the
          // authority, so sort by it and only fall back to array order for
          // fields that carry no sequence at all.
          //
          // It is an ORDINAL, never a grid slot: Zoho's own sample layout has
          // gaps (16, 18, 19 … 23, 26, 30) where fields were moved to Unused,
          // and outright ties (Last_Name and Full_Name both 4). Computing a
          // row from it arithmetically would put fields in the wrong places on
          // any layout an admin has ever edited. Sort, then deal by position.
          raw.sort((a: any, b: any) => {
            const sa = Number(a?.sequence_number); const sb2 = Number(b?.sequence_number);
            if (Number.isFinite(sa) && Number.isFinite(sb2)) return sa - sb2;
            if (Number.isFinite(sa)) return -1;
            if (Number.isFinite(sb2)) return 1;
            return 0;
          });
          sections.push({
            name: String(sec?.display_label || sec?.name || "").trim(),
            cols: Math.max(1, Number(sec?.column_count) || 1),
            fields: raw.map((f: any) => String(f?.api_name || "")).filter(Boolean),
          });
        }
      }

      // Zoho lays a multi-column section out ACROSS first: with two columns,
      // sequence 1 is top-left, 2 is top-right, 3 is second-row-left. Reading
      // that list straight down therefore zig-zags between the two columns,
      // which is exactly the "information is all over the place" the user saw.
      // Regroup it the way a person reads the page: the whole left column top
      // to bottom, then the whole right column.
      const columnMajor = (apis: string[], cols: number) => {
        if (cols < 2 || apis.length < 2) return apis;
        const out: string[] = [];
        for (let c = 0; c < cols; c++)
          for (let i = c; i < apis.length; i += cols) out.push(apis[i]);
        return out;
      };

      // Labels the user has asked never to see again. Matched on the LABEL and
      // not the api name because these are custom fields whose api names are
      // org-generated noise, and matched loosely because Zoho labels wander
      // between straight and curly apostrophes.
      const labelKey = (v: string) => String(v || "").toLowerCase().replace(/[^a-z]/g, "");
      const HIDDEN_LABELS = new Set([
        "trigger",            // an automation flag, meaningless to an agent
        "spousesfirstname",   // already inside Spouse's Contact Connection
        "spouseslastname",
      ]);

      // Everything the sheet already shows by other means, plus Zoho's own
      // plumbing. Repeating these under a "Residential Buyer" heading is noise.
      const SKIP = new Set([
        "id", "Owner", "Created_By", "Modified_By", "Created_Time", "Modified_Time",
        "Last_Activity_Time", "Tag", "First_Name", "Last_Name", "Full_Name", "Email",
        "Phone", "Mobile", "Other_Phone", "Home_Phone", "Fax", "Account_Name",
        "Mailing_City", "Mailing_State", "Mailing_Street", "Mailing_Zip", "Mailing_Country",
        "Client_Classification", "Lead_Source", "Description", "Email_Opt_Out",
        "Record_Image", "Unsubscribed_Mode", "Unsubscribed_Time", "Change_Log_Time__s",
        "Locked__s", "Enrich_Status__s", "Last_Enriched_Time__s", prospectApi,
      ].filter(Boolean) as string[]);
      const keep = (a: string) =>
        !SKIP.has(a) && !HIDDEN_LABELS.has(labelKey(meta.get(a)?.field_label || ""));

      // The spouse's details arrive scattered across the layout. They describe
      // ONE person, so they are pulled together and put in the order someone
      // would actually use them: who it is, then how to reach them.
      const spouseRank = (a: string) => {
        const k = labelKey(meta.get(a)?.field_label || "");
        if (!k.startsWith("spouse")) return -1;
        if (k.includes("contactconnection")) return 0;
        if (k.includes("mobile") || k.includes("phone")) return 1;
        if (k.includes("email")) return 2;
        return 3;
      };
      const groupSpouse = (apis: string[]) => {
        const spouse = apis.filter(a => spouseRank(a) >= 0)
          .sort((a, b) => spouseRank(a) - spouseRank(b));
        if (spouse.length < 2) return apis;
        const out: string[] = [];
        let placed = false;
        for (const a of apis) {
          if (spouseRank(a) >= 0) {
            if (!placed) { out.push(...spouse); placed = true; }
            continue;   // every other spouse field is already in the block
          }
          out.push(a);
        }
        return out;
      };
      const arrange = (apis: string[], cols: number) => groupSpouse(columnMajor(apis.filter(keep), cols));

      // 3 -- the record, in ONE call. `fields=` is documented as "mandatory
      //      when fetching all records" — meaning it is OPTIONAL when fetching
      //      a specific one, and omitting it returns the entire record. Same
      //      single API credit either way. Asking for a named subset only ever
      //      bought a smaller payload, and it cost a round trip per 45 names
      //      plus a whole extra call earlier just to learn the form type.
      //
      //      Reading everything once also fixes that second call for free: by
      //      the time the type is needed the value is already in hand. Zoho
      //      only returns subforms and multi-select lookups on a specific-
      //      record read as well, so this is strictly more capable, not just
      //      fewer calls.
      const values: Record<string, any> = {};
      let readFailed = 0;
      let wholeRecordRead = false;
      const readFields = async (_apis?: string[]) => {
        if (wholeRecordRead) return;
        wholeRecordRead = true;
        try {
          const rr = await get(`https://${apiDomain}/crm/v6/Contacts/${cid}`);
          if (!rr.ok) { readFailed++; try { await rr.body?.cancel(); } catch { /* drained */ } return; }
          const rd = await rr.json().catch(() => ({}));
          const rec = rd?.data?.[0];
          if (rec) for (const k of Object.keys(rec)) values[k] = rec[k];
        } catch { readFailed++; }
      };

      // Flatten Zoho's shapes to something printable. A lookup is an object, a
      // multi-select is an array, and "-None-" is Zoho's way of writing empty.
      // A false checkbox flattens to EMPTY rather than the string "false":
      // "Trigger: false" was being printed as though somebody had filled it in.
      const flat = (v: any): string => {
        if (v === null || v === undefined || v === "") return "";
        if (v === true) return "Yes";
        if (v === false) return "";
        if (Array.isArray(v)) return v.map(flat).filter(Boolean).join(", ");
        if (typeof v === "object") return String(v.name ?? v.display_value ?? "").trim();
        const t = String(v).trim();
        return /^-?\s*none\s*-?$/i.test(t) ? "" : t;
      };

      const norm = (v: string) => String(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const matchSection = (t: string) => sections.filter(x => x.name && norm(x.name) === norm(t))[0];

      // Work out the form type with as few calls as possible: trust the hint
      // the row already drew, and only go and ask Zoho when there isn't one.
      let types: string[] = [];
      if (typeHint.length && typeHint.filter(matchSection).length === typeHint.length) {
        types = typeHint;
      } else if (prospectApi) {
        await readFields([prospectApi]);
        types = (Array.isArray(values[prospectApi]) ? values[prospectApi].map(flat) : [flat(values[prospectApi])]).filter(Boolean);
      }

      const matched = types.map(matchSection).filter(Boolean);
      let plan: Array<{ title: string; source: string; apis: string[] }> = [];
      if (matched.length) {
        plan = types.filter(matchSection).map(t => {
          const sec = matchSection(t)!;
          return { title: t, source: "section", apis: arrange(sec.fields, sec.cols) };
        });
      } else {
        // The expensive path, and only now: no section is named after the form
        // type, so the candidate set is every custom field on the module.
        const custom = allFields
          .filter((f: any) => f?.api_name && f?.custom_field && f?.data_type !== "subform")
          .map((f: any) => String(f.api_name));
        plan = [{ title: types.join(" · ") || prospectLabel, source: "filled", apis: groupSpouse(custom.filter(keep)) }];
      }
      await readFields(Array.from(new Set(plan.flatMap(g => g.apis))));
      if (!Object.keys(values).length) return json({ error: "Couldn’t read that contact." }, 404);

      const entry = (api: string) => {
        const m = meta.get(api) || {};
        const raw = values[api];
        // A lookup carries the id of the record it points at. Keeping it is
        // what lets "Spouse's Contact Connection" become a link to the spouse
        // instead of their name as dead text.
        const linkId = (raw && typeof raw === "object" && !Array.isArray(raw) && raw.id) ? String(raw.id) : null;
        return {
          api,
          label: String(m.field_label || api),
          type: String(m.data_type || "text"),
          read_only: !!(m.read_only || m.field_read_only),
          options: Array.isArray(m.pick_list_values)
            ? m.pick_list_values.filter((p: any) => p?.type !== "deleted_value").map((p: any) => String(p.display_value))
            : null,
          value: flat(raw),
          link_module: linkId ? String(m.lookup?.module?.api_name || m.lookup?.module || "Contacts") : null,
          link_id: linkId,
        };
      };

      // `fields` are the ones with a value -- that is the at-a-glance summary.
      // `empty` are the rest of the same candidate set, kept apart rather than
      // dropped: the pop-out has to let someone FILL a blank field, not only
      // change a filled one, and a field it never returned is a field nobody
      // can ever complete from this app.
      const groups = plan.map(g => {
        const all = g.apis.map(entry);
        return {
          title: g.title, source: g.source,
          fields: all.filter(f => !!f.value),
          empty: all.filter(f => !f.value && !f.read_only).slice(0, 40),
        };
      }).filter(g => g.fields.length || g.empty.length || types.length);

      return json({
        contact_id: cid,
        prospect_label: prospectLabel,
        prospect_api: prospectApi || null,
        types,
        groups,
        sections_read: !!ld,
        batches_failed: readFailed,
      }, 200);
    }

    // ── Re-grant the org's Zoho authorization [admin] ──────────────
    //  Adding a scope to a Zoho grant is not an edit — Zoho mints a whole new
    //  refresh token against the new scope list and the old one keeps working
    //  until it is replaced. The admin pastes a 10-minute grant code from
    //  Zoho's Self Client console; this exchanges it and installs the result.
    //
    //  THE ORDER MATTERS. The live refresh token is the single credential every
    //  Zoho feature in this app runs on, so it is replaced LAST, and only after
    //  the new one has proved it can still do the things the old one does:
    //
    //    1. exchange the code            (nothing written)
    //    2. mint an access token         (nothing written)
    //    3. probe modules + settings     (nothing written)
    //    4. only if BOTH pass, write     ← the first and only write
    //
    //  A grant that comes back missing module or settings access is rejected
    //  outright. Everything else — users, emails, coql — is reported but never
    //  blocking: those are features, and losing one is not worth refusing a
    //  reconnect the admin deliberately asked for.
    if (action === "zoho_reconnect") {
      if (!(auth as any).isService) {
        const { data: prof } = await sb.from("profiles").select("access").eq("id", auth.userId).maybeSingle();
        const roles = Array.isArray(prof?.access) ? prof.access : [];
        if (!roles.includes("admin")) return json({ error: "Admin access required." }, 403);
      }
      const code = String(body.code || "").trim();
      if (!code) return json({ error: "Paste the grant code from Zoho first." }, 400);

      const clientId = Deno.env.get("ZOHO_CLIENT_ID") || "";
      const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET") || "";
      if (!clientId || !clientSecret)
        return json({ error: "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET are not set on this function." }, 500);

      const conn = await loadConnection(sb);
      const accountsUrl = conn.accounts_url || "https://accounts.zoho.com";

      // 1 — code → tokens.
      let minted: any = {};
      try {
        const tr = await fetch(`${accountsUrl}/oauth/v2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId, client_secret: clientSecret, code,
          }).toString(),
        });
        minted = await tr.json().catch(() => ({}));
      } catch (e) {
        return json({ error: "Couldn’t reach Zoho to exchange the code." }, 502);
      }
      if (!minted.refresh_token) {
        // "invalid_code" is overwhelmingly an expired one — Zoho's console
        // codes last ten minutes and are single use. Say that, because
        // "invalid" reads as "you pasted it wrong" and sends them hunting.
        const raw = String(minted.error || minted.error_description || "unknown");
        const friendly = /invalid.?code/i.test(raw)
          ? "Zoho rejected that code. They expire after 10 minutes and only work once — generate a fresh one."
          : "Zoho didn’t return a refresh token: " + raw;
        return json({ error: friendly, zoho_error: raw }, 400);
      }

      // Zoho hands api_domain back as a full URL ("https://www.zohoapis.com"),
      // but this row stores a BARE HOST -- every call site in this file builds
      // `https://${apiDomain}/crm/v6/...`. Storing Zoho's value verbatim would
      // produce "https://https://www.zohoapis.com/..." in all ~25 of them, which
      // is not a 4xx you could debug from a log: fetch rejects it as an invalid
      // URL before a request is ever made. Strip the scheme and anything past
      // the host, so what lands in the row is what the rest of the file expects.
      const bareHost = (v: unknown) =>
        String(v || "").trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      const newApiDomain = bareHost(minted.api_domain) || bareHost(conn.api_domain) || "www.zohoapis.com";
      const at = String(minted.access_token || "");

      // 2/3 — what can the NEW grant actually do? Every probe is a read, and
      // the Emails one uses record id "1", which cannot be a real Zoho id.
      const probe = async (url: string) => {
        try {
          const r = await fetch(url, { headers: { Authorization: "Zoho-oauthtoken " + at } });
          if (r.status === 204) return { ok: true, http: 204, code: null };
          const d = await r.json().catch(() => ({}));
          const c = String(d?.code || "");
          // A scope refusal is the ONLY "no". Anything else (a bad id, an empty
          // module) means the door was open and the request failed past it.
          if (c === "OAUTH_SCOPE_MISMATCH") return { ok: false, http: r.status, code: c };
          return { ok: true, http: r.status, code: c || null };
        } catch { return { ok: false, http: 0, code: "unreachable" }; }
      };

      const [modules, settings, users, emails] = await Promise.all([
        probe(`https://${newApiDomain}/crm/v6/Contacts?fields=Email&per_page=1`),
        probe(`https://${newApiDomain}/crm/v6/settings/modules`),
        probe(`https://${newApiDomain}/crm/v6/users?type=ActiveUsers&per_page=1`),
        probe(`https://${newApiDomain}/crm/v6/Contacts/1/Emails`),
      ]);

      const grants = {
        records: modules.ok, settings: settings.ok,
        users: users.ok, contact_emails: emails.ok,
      };
      // A refusal must say WHICH probe failed and what Zoho actually said.
      // The first version of this returned a bare "records or settings" and the
      // real cause -- a malformed api_domain that made every probe unreachable
      // -- was indistinguishable from a genuinely narrow grant.
      const detail = {
        records: modules, settings: settings, users: users, contact_emails: emails,
        api_domain: newApiDomain,
      };
      if (!modules.ok || !settings.ok) {
        const unreachable = modules.code === "unreachable" || settings.code === "unreachable";
        return json({
          error: unreachable
            ? "The grant was accepted but this server could not reach Zoho to verify it, so nothing was installed — the old connection is untouched. This is a fault on our side, not with your code."
            : "That grant can’t read Zoho records or module settings, so it was NOT installed — the old connection is untouched. Generate a new code with the full scope list.",
          installed: false, grants, detail,
        }, 400);
      }

      // 4 — install. The previous token is kept so a bad grant that slipped
      // past the probes is one UPDATE away from being undone, and the cached
      // access token is cleared so nothing serves a request on the old scope.
      const { error: upErr } = await sb.from("zoho_connection").update({
        previous_refresh_token: conn.refresh_token,
        refresh_token: minted.refresh_token,
        api_domain: newApiDomain,
        access_token: null,
        access_token_expires_at: null,
        reconnected_at: new Date().toISOString(),
      }).eq("refresh_token", conn.refresh_token);
      if (upErr) return json({ error: "Zoho accepted the code but the new key couldn’t be saved: " + upErr.message, installed: false, grants }, 500);

      return json({ ok: true, installed: true, grants, detail, api_domain: newApiDomain }, 200);
    }

    // ── Probe whether this connection may read a Contact's Emails [read-only] ──
    //  The Emails tab on a Zoho contact is a related list with its OWN OAuth
    //  scope (ZohoCRM.modules.emails.READ) — separate from the module scopes
    //  this app already uses. Nobody recorded which scopes the stored refresh
    //  token was granted, and Zoho has no endpoint that reports them back, so
    //  the only way to find out is to ask and read the refusal.
    //
    //  Safe by construction: GET only, and by default it targets record id "1",
    //  which can never be a real Zoho id (those are 18-19 digits). Zoho enforces
    //  scope at the gateway BEFORE record handling:
    //    • scope missing → 401 OAUTH_SCOPE_MISMATCH  (nothing read)
    //    • scope present → a benign invalid-id error  (nothing read)
    //
    //  Pass contact_id to also probe a REAL contact — that answers the second
    //  question, whether emails actually come back and whether the payload
    //  carries message CONTENT or only headers. It reports counts and FIELD
    //  NAMES only; no subjects, addresses or bodies are ever returned.
    if (action === "probe_emails") {
      if (!(auth as any).isService) {
        const { data: prof } = await sb.from("profiles").select("access").eq("id", auth.userId).maybeSingle();
        const roles = Array.isArray(prof?.access) ? prof.access : [];
        if (!roles.includes("admin")) return json({ error: "Admin access required." }, 403);
      }
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const realId = /^[0-9]{6,32}$/.test(String(body.contact_id || "")) ? String(body.contact_id) : null;

      const attempt = async (label: string, url: string) => {
        try {
          const r = await zohoFetch(sb, conn, accessToken, url, {});
          if (r.status === 204) return { label, http: 204, note: "no emails on this record" };
          const d = await r.json().catch(() => ({}));
          const rows = Array.isArray(d?.Emails) ? d.Emails : (Array.isArray(d?.data) ? d.data : null);
          return {
            label, http: r.status,
            code: d?.code || d?.status || null,
            message: typeof d?.message === "string" ? d.message.slice(0, 200) : null,
            count: rows ? rows.length : null,
            // field names only — never values
            fields: rows && rows[0] ? Object.keys(rows[0]).slice(0, 40) : null,
            envelope: rows ? null : Object.keys(d || {}).slice(0, 12),
          };
        } catch (e) { return { label, error: String((e as any)?.message || e).slice(0, 200) }; }
      };

      const checks = [
        await attempt("scope probe (fake id)", `https://${apiDomain}/crm/v6/Contacts/1/Emails`),
      ];
      if (realId) {
        checks.push(await attempt("real contact", `https://${apiDomain}/crm/v6/Contacts/${realId}/Emails`));
      }
      return json({ ok: true, checks }, 200);
    }

    // ── Probe the token's OAuth scope for update/delete [CRM] ───────
    //  This answers "does the CONNECTION (not just the Zoho profile) actually
    //  allow editing/deleting?" — the gate the list_modules flags can't see.
    //
    //  How it stays safe: we send an UPDATE and a DELETE for the record id
    //  "1". Real Zoho record ids are 18-19 digit numbers, so "1" can NEVER
    //  match a real record. Zoho enforces OAuth scope at the gateway BEFORE
    //  the request reaches record handling, so:
    //    • scope missing → 401 OAUTH_SCOPE_MISMATCH  (nothing processed)
    //    • scope present → benign "invalid id" error (nothing modified)
    //  Either way no record is ever changed or removed.
    if (action === "probe_scopes") {
      const moduleName = (body.module || "Contacts").trim();
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const BOGUS = "1"; // structurally invalid id — cannot match a real record

      // Read a verdict from an HTTP status + parsed Zoho body. The only
      // "blocked" signal is OAUTH_SCOPE_MISMATCH; any other outcome means the
      // operation was authorized (it merely failed on the fake id).
      const verdict = (status: number, data: any) => {
        const code = data?.code || data?.data?.[0]?.code || null;
        const message = data?.message || data?.data?.[0]?.message || null;
        if (code === "OAUTH_SCOPE_MISMATCH")
          return { allowed: false, determinate: true, code, message };
        if (code === "INVALID_TOKEN" || code === "AUTHENTICATION_FAILURE")
          return { allowed: null, determinate: false, code, message };
        return { allowed: true, determinate: true, code, message };
      };

      // UPDATE probe — PUT a bogus id with no real field changes.
      let update;
      try {
        const r = await fetch(`https://${apiDomain}/crm/v6/${moduleName}`, {
          method: "PUT",
          headers: {
            Authorization: "Zoho-oauthtoken " + accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ data: [{ id: BOGUS }] }),
        });
        update = verdict(r.status, await r.json().catch(() => ({})));
      } catch (e) {
        update = { allowed: null, determinate: false, code: "REQUEST_FAILED", message: String(e?.message || e) };
      }

      // DELETE probe — DELETE a bogus id via the ids param.
      let del;
      try {
        const u = new URL(`https://${apiDomain}/crm/v6/${moduleName}`);
        u.searchParams.set("ids", BOGUS);
        const r = await fetch(u.toString(), {
          method: "DELETE",
          headers: { Authorization: "Zoho-oauthtoken " + accessToken },
        });
        del = verdict(r.status, await r.json().catch(() => ({})));
      } catch (e) {
        del = { allowed: null, determinate: false, code: "REQUEST_FAILED", message: String(e?.message || e) };
      }

      return json({ module: moduleName, update, delete: del }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
