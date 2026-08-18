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
  try {
    const url = `https://${apiDomain}/crm/v6/users/search?email=${encodeURIComponent(email)}`;
    const res = await zohoFetch(sb, conn, accessToken, url, { method: "GET" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const u = data?.users?.[0];
    return u?.id || null;
  } catch (_) {
    return null;
  }
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

      // Owner = whoever is actually logged in, not whoever owns the Zoho connection.
      // Best-effort: if the email doesn't resolve to a Zoho user, Zoho falls back to
      // its old default (API-connection owner) rather than the create failing. That
      // fallback is reported back as owner_warning so a mis-owned record is visible
      // at submit time instead of being discovered in Zoho weeks later.
      let ownerWarning: string | null = null;
      const ownerEmail = typeof body.owner_email === "string" ? body.owner_email.trim() : "";
      if (ownerEmail) {
        const ownerId = await resolveZohoOwnerId(sb, conn, accessToken, apiDomain, ownerEmail);
        if (ownerId) record.Owner = { id: ownerId };
        else ownerWarning = `No Zoho CRM user matches ${ownerEmail}, so Zoho assigned this record to the API connection owner instead. Ask an admin to confirm this person is an active Zoho user with that exact email.`;
      } else {
        ownerWarning = "No account email was available for the submitter, so Zoho assigned this record to the API connection owner instead.";
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
      return json(
        {
          ok: true,
          id: created?.details?.id || null,
          status: created?.status || "success",
          owner_warning: ownerWarning,
        },
        200
      );
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
    if (action === "create_record") {
      const moduleName = (body.module || "Tasks").trim();
      const record = body.record;
      if (!record || typeof record !== "object" || !Object.keys(record).length)
        return json({ error: "Missing record." }, 400);
      const conn = await loadConnection(sb);
      const accessToken = await getZohoToken(sb, conn);
      const apiDomain = conn.api_domain || "www.zohoapis.com";
      const r = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/${moduleName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: [record] }),
      });
      const d = await r.json().catch(() => ({}));
      const row = d?.data?.[0];
      if (!r.ok || row?.status !== "success")
        return json({ error: row?.message || d?.message || "Could not create record", detail: d }, r.ok ? 400 : r.status);
      return json({ ok: true, id: row?.details?.id || null }, 200);
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
      const fields =
        Array.isArray(body.fields) && body.fields.length
          ? body.fields.filter(Boolean).join(",")
          : "Owner,Subject,Status,Due_Date,Closed_Time,Description,Who_Id,What_Id,Priority";

      const base = statusNot
        ? `https://${apiDomain}/crm/v6/${moduleName}/search`
        : `https://${apiDomain}/crm/v6/${moduleName}`;
      const url = new URL(base);
      url.searchParams.set("fields", fields);
      url.searchParams.set("per_page", String(per));
      if (statusNot) {
        const val = String(statusNot).replace(/[()]/g, "").slice(0, 80);
        url.searchParams.set("criteria", `(Status:not_equal:${val})`);
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
      const fields = "First_Name,Last_Name,Full_Name,Email,Phone,Mobile,Mailing_City,Mailing_State,Lead_Source,Created_Time";

      let id = (body.id || "").toString().trim();
      if (!id && body.name) {
        const u = new URL(`https://${apiDomain}/crm/v6/Contacts/search`);
        u.searchParams.set("word", String(body.name).trim());
        u.searchParams.set("per_page", "1");
        const sr = await zohoFetch(sb, conn, accessToken, u.toString(), {});
        if (sr.status !== 204) { const sd = await sr.json().catch(() => ({})); id = sd?.data?.[0]?.id || ""; }
      }
      if (!id) return json({ contact: null }, 200);

      const r = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Contacts/${id}?fields=${encodeURIComponent(fields)}`, {});
      if (r.status === 204) return json({ contact: null }, 200);
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.message || "Zoho contact error" }, r.status);
      const c = d?.data?.[0];
      if (!c) return json({ contact: null }, 200);
      return json({ contact: {
        id: c.id,
        full_name: c.Full_Name || `${c.First_Name || ""} ${c.Last_Name || ""}`.trim(),
        email: c.Email || null, phone: c.Phone || c.Mobile || null,
        city: c.Mailing_City || null, state: c.Mailing_State || null,
        lead_source: c.Lead_Source || null, created: c.Created_Time || null,
      } }, 200);
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
      let spouseApi = (body.spouse_field || "").toString().replace(/[^A-Za-z0-9_]/g, "");
      if (!spouseApi) {
        const fr = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/settings/fields?module=Contacts`, {});
        if (fr.ok) {
          const fd = await fr.json().catch(() => ({}));
          const f = (fd.fields || []).find((x: any) => /spouse|partner/i.test(x.field_label || "") && x.data_type === "lookup");
          spouseApi = f?.api_name || "";
        }
      }
      if (!spouseApi) return json({ error: "No Spouse lookup field found on Contacts.", links: {} }, 200);

      const links: Record<string, any> = {};
      const B = 10;
      for (let i = 0; i < ids.length; i += B) {
        const batch = ids.slice(i, i + B);
        const res = await Promise.all(batch.map(async (id: string) => {
          try {
            const r = await zohoFetch(sb, conn, accessToken, `https://${apiDomain}/crm/v6/Contacts/${id}?fields=${spouseApi}`, {});
            if (!r.ok) return [id, null];
            const d = await r.json().catch(() => ({}));
            const sp = d?.data?.[0]?.[spouseApi];
            return [id, sp && sp.id ? { id: sp.id, name: sp.name || null } : null];
          } catch { return [id, null]; }
        }));
        for (const [id, sp] of res) links[id as string] = sp;
      }
      return json({ field: spouseApi, links }, 200);
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
