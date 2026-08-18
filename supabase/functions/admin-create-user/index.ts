// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: admin-create-user
// Lets an admin add a teammate directly, ACTIVE from the moment they're
// created — skips the normal "sign in once, wait to be approved" flow.
//
// Why this has to be an edge function: creating a Supabase Auth user can
// ONLY be done with the service role key, which can never be exposed to the
// browser. There is no client-side way to pre-provision a login.
//
// How it avoids the pending screen: sign-in here is Google OAuth only, no
// passwords (see supabase.js). This creates the Auth user up front with
// email_confirm:true and no password, plus its profiles row with
// status:'active' already set. When that person later signs in with Google
// using the SAME email, Supabase Auth links the OAuth identity to this
// existing account (standard behavior for a verified/confirmed email) —
// their already-active profile is what greets them; ensureProfile() in the
// app never gets a chance to auto-create a fresh 'pending' one because a
// profile with their id already exists.
//
// Deploy: Edge Functions → new function `admin-create-user` → paste → Deploy.
//   Leave "Verify JWT" ON (the app sends the signed-in admin's token).
// Secrets: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (injected automatically).
//
// Request (from the app): POST { email, first_name, last_name, title,
//   employee_id, access:[...], reports_to, assigned_tc } with the caller's
//   Authorization: Bearer <session token>. The caller must be an ACTIVE
//   profile with "admin" in access — enforced here, server-side, not just
//   hidden behind a UI button, since this action can create real accounts.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

const VALID_ACCESS = ["admin", "operations", "agent", "tc"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = serviceClient();
  if (!sb) return json({ error: "server not configured" }, 500);

  // Require a signed-in, ACTIVE, admin caller — checked here, not trusted from the client.
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const { data: ures } = await sb.auth.getUser(token);
  if (!ures?.user) return json({ error: "unauthorized" }, 401);

  const { data: callerProfile, error: cpErr } = await sb
    .from("profiles").select("status, access").eq("id", ures.user.id).maybeSingle();
  if (cpErr || !callerProfile) return json({ error: "No profile for this account." }, 403);
  const callerRoles = Array.isArray(callerProfile.access) ? callerProfile.access : [];
  if (callerProfile.status !== "active" || !callerRoles.includes("admin")) {
    return json({ error: "Admin access required." }, 403);
  }

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* ignore */ }

  const email = String(body.email || "").trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return json({ error: "A valid email is required." }, 400);
  const firstName = String(body.first_name || "").trim() || null;
  const lastName = String(body.last_name || "").trim() || null;
  const title = String(body.title || "").trim() || null;
  const employeeId = String(body.employee_id || "").trim() || null;
  const reportsTo = body.reports_to || null;
  const assignedTc = body.assigned_tc || null;
  const access = Array.isArray(body.access) ? body.access.filter((a: unknown) => VALID_ACCESS.includes(String(a))) : [];

  // Refuse a duplicate — a profile with this email already existing means either they've
  // already signed in once (pending/active/disabled) or someone already pre-added them.
  const { data: existing } = await sb.from("profiles").select("id").ilike("email", email).maybeSingle();
  if (existing) return json({ error: "A profile with this email already exists." }, 409);

  const fullName = [firstName, lastName].filter(Boolean).join(" ") || null;
  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email,
    email_confirm: true, // no password — they sign in with Google; this just marks the address verified
    user_metadata: fullName ? { full_name: fullName } : {},
  });
  if (createErr || !created?.user) {
    return json({ error: createErr?.message || "Could not create the login account." }, 400);
  }

  const { error: insErr } = await sb.from("profiles").insert({
    id: created.user.id,
    email,
    first_name: firstName,
    last_name: lastName,
    title,
    employee_id: employeeId,
    reports_to: reportsTo,
    assigned_tc: assignedTc,
    access,
    status: "active",
  });
  if (insErr) {
    // Don't leave a login-capable account sitting with no profile behind it.
    await sb.auth.admin.deleteUser(created.user.id).catch(() => {});
    return json({ error: "Created the login but could not save the profile: " + insErr.message }, 500);
  }

  return json({ ok: true, id: created.user.id });
});
