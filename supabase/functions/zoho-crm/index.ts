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
  if (error || !user)
    return { ok: false as const, status: 401, error: "Invalid or expired session." };

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

      let extraFailed = false;
      let r = await getWith(extra.length ? baseFields + "," + extra.join(",") : baseFields);
      if (!r.ok && r.status === 400 && extra.length) {
        extraFailed = true;
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
      const CF_TASKS = 12;  // enough to find the last completed touch

      const contactFields = "First_Name,Last_Name,Full_Name,Email,Phone,Mobile,Other_Phone," +
        "Mailing_City,Mailing_State,Lead_Source,Created_Time,Client_Classification,Owner";

      const cr = await zohoFetch(sb, conn, accessToken,
        `https://${apiDomain}/crm/v6/Contacts/${cid}?fields=${encodeURIComponent(contactFields)}`, {});
      if (cr.status === 204) return json({ found: false }, 200);
      if (!cr.ok) return json({ error: "zoho_unavailable", retryable: true }, 502);
      const cd = await cr.json().catch(() => ({}));
      const c = cd?.data?.[0];
      if (!c) return json({ found: false }, 200);

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

      const [dealsRes, tasksRes] = await Promise.all([
        related("Deals", "Deal_Name,Stage,Amount,Closing_Date,Type,Owner", CF_DEALS),
        related("Tasks", "Subject,Status,Due_Date,Closed_Time", CF_TASKS),
      ]);

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
        })),
        tasks_read: tasksRes.ok,
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
