// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: zoho-setup
// ONE-TIME bootstrap utility: exchanges a freshly-generated Zoho Self Client
// authorization code for a refresh token, auto-discovers the Zoho Projects
// portal, and saves the connection row — the manual step that unblocks the
// Zoho Projects two-way sync (plan: hidden-wiggling-lamport).
//
// NOT deployed by default (deployed once on 2026-08-14 to bootstrap the
// connection, then deleted + its ZOHO_SETUP_SECRET unset immediately after —
// no point leaving an elevated-write endpoint live once its one job is done).
// Kept here as source so redoing the connection later (e.g. if the refresh
// token is ever revoked) is a redeploy + a fresh Zoho code, not a rebuild.
// To reuse: `supabase secrets set ZOHO_SETUP_SECRET=<new random value>`,
// `supabase functions deploy zoho-setup --no-verify-jwt`, call it with a
// fresh code, then delete + unset again.
//
// Deploy with --no-verify-jwt (this has no Supabase user session to check —
// it runs before any TMG login even applies).
//
// Secrets required:
//   ZOHO_SETUP_SECRET   = a random value only the deployer holds, checked below
//   ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET = same Zoho API client as zoho-crm/zoho-projects
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY = injected automatically
//
// POST { code: "<the code from Zoho's Generate Code screen>" }
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const secret = Deno.env.get("ZOHO_SETUP_SECRET") || "";
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || auth !== secret) return json({ error: "unauthorized" }, 401);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return json({ error: "server not configured" }, 500);
  const sb = createClient(url, key);

  const body = await req.json().catch(() => ({}));
  const code = (body.code || "").toString().trim();
  if (!code) return json({ error: "Missing code." }, 400);

  const clientId = Deno.env.get("ZOHO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET") || "";
  if (!clientId || !clientSecret) return json({ error: "ZOHO_CLIENT_ID/ZOHO_CLIENT_SECRET not configured." }, 500);

  // Self Client authorization-code exchange — no redirect_uri needed (unlike a
  // browser OAuth flow), per Zoho's Self Client docs.
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
  });
  const tr = await fetch("https://accounts.zoho.com/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const td = await tr.json().catch(() => ({}));
  if (!tr.ok || !td.access_token || !td.refresh_token) {
    return json({ error: td.error_description || td.error || "Zoho token exchange failed — the code may have expired (they're only good for ~10 min and single-use).", detail: td }, tr.status || 400);
  }

  // Auto-discover the portal so nobody has to hunt for a portal ID by hand.
  const pr = await fetch("https://projectsapi.zoho.com/restapi/portals/", {
    headers: { Authorization: "Zoho-oauthtoken " + td.access_token },
  });
  const pd = await pr.json().catch(() => ({}));
  const portals = (pd.portals || []).map((p: any) => ({ id: p.id_string || String(p.id), name: p.name }));

  if (!portals.length) {
    return json({ ok: false, error: "Token exchange succeeded, but no Zoho Projects portals were found for this account.", detail: pd }, 200);
  }

  const expiresAt = new Date(Date.now() + (Number(td.expires_in) || 3600) * 1000).toISOString();

  if (portals.length > 1) {
    // Multiple portals on this account — don't guess, return the list so a
    // human picks. Nothing saved yet; call again with `portal_id` set.
    if (!body.portal_id) return json({ ok: false, needsPortalChoice: true, portals }, 200);
    const chosen = portals.find((p: any) => p.id === String(body.portal_id));
    if (!chosen) return json({ ok: false, error: "portal_id not found among this account's portals.", portals }, 400);
    await sb.from("zoho_projects_connection").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    await sb.from("zoho_projects_connection").insert({ refresh_token: td.refresh_token, portal_id: chosen.id, access_token: td.access_token, access_token_expires_at: expiresAt });
    return json({ ok: true, portal: chosen }, 200);
  }

  await sb.from("zoho_projects_connection").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await sb.from("zoho_projects_connection").insert({ refresh_token: td.refresh_token, portal_id: portals[0].id, access_token: td.access_token, access_token_expires_at: expiresAt });
  return json({ ok: true, portal: portals[0] }, 200);
});
