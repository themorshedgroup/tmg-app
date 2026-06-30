// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: ai-chat
// Proxies Claude API calls so the API key never touches the browser.
//
// Deploy: Supabase Dashboard → Edge Functions → function `ai-chat`
//   Paste this whole file, then click Deploy.
//
// Secret required (Dashboard → Edge Functions → Manage secrets):
//   ANTHROPIC_API_KEY = <your Claude API key>
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// ── ACCESS CONTROL ─────────────────────────────────────────────────────
// Every request MUST carry a valid TMG user session (Authorization: Bearer
// <access_token>). This function verifies the JWT and requires the caller's
// profiles.status to be 'active'. Anonymous callers, expired sessions, and
// pending/disabled users are rejected — so the endpoint can't be abused as
// an open Claude proxy even though its URL is public. (verify_jwt stays OFF
// in the dashboard; we authorize in-code so the anon publishable key alone
// is not enough to call it.)
//
// ── MODEL CONTROL (the ONE dial) ───────────────────────────────────────
// The model for EVERY AI activity in the TMG app is read from ONE table row:
//   table:  ai_config   row id = 1   column: model
// To change the model app-wide, edit that single row. If the row is
// missing/unreadable, it falls back to DEFAULT_MODEL below.
// ───────────────────────────────────────────────────────────────────────
//
// Endpoint after deploy:
//   https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/ai-chat
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_MODEL = "claude-sonnet-5"; // fallback only; ai_config row wins

// Service-role client (server-side only; bypasses RLS for model + profile lookups).
function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key);
}

// Verifies the caller's session JWT and requires an ACTIVE TMG profile.
// Returns { ok:true, userId } or { ok:false, status, error }.
async function authorizeCaller(req: Request) {
  const sb = serviceClient();
  if (!sb) return { ok: false as const, status: 500, error: "Server auth not configured." };

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false as const, status: 401, error: "Sign in required." };

  // Validate the JWT against the auth server (rejects the anon key, expired/forged tokens).
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return { ok: false as const, status: 401, error: "Invalid or expired session." };

  // Require an active profile (blocks pending / disabled / missing).
  const { data: profile, error: pErr } = await sb
    .from("profiles").select("status").eq("id", user.id).single();
  if (pErr || !profile) return { ok: false as const, status: 403, error: "Account pending approval." };
  if (profile.status !== "active") return { ok: false as const, status: 403, error: "Account is not active." };

  return { ok: true as const, userId: user.id };
}

// Reads the active model from the ai_config table (single source of truth).
async function getActiveModel(): Promise<string> {
  try {
    const sb = serviceClient();
    if (!sb) return DEFAULT_MODEL;
    const { data, error } = await sb
      .from("ai_config").select("model").eq("id", 1).single();
    if (error || !data?.model) return DEFAULT_MODEL;
    return data.model;
  } catch {
    return DEFAULT_MODEL;
  }
}

Deno.serve(async (req) => {
  // Browser preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    // ── Gate: only signed-in, active TMG users may call this. ──
    const auth = await authorizeCaller(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return json({ error: "ANTHROPIC_API_KEY not set in Supabase secrets." }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const {
      messages = [],
      system = "",
      max_tokens = 1024,
      feature = "other",
    } = body;
    // Which app surface made this call (for per-feature cost attribution).
    const feat = (typeof feature === "string" && feature.trim())
      ? feature.trim().slice(0, 40) : "other";

    if (!Array.isArray(messages) || messages.length === 0) {
      return json({ error: "Request must include a non-empty 'messages' array." }, 400);
    }

    // Single source of truth for the model — from the ai_config table.
    const model = await getActiveModel();

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });

    const data = await anthropicRes.json();

    if (!anthropicRes.ok) {
      return json({ error: data?.error?.message || "Claude API error", detail: data }, anthropicRes.status);
    }

    // Flatten Claude's content blocks into a single text string for the client.
    const text = Array.isArray(data.content)
      ? data.content.map((b: any) => b?.text || "").join("")
      : "";

    // Log token usage per user (best-effort; never block the reply on logging).
    try {
      const sb = serviceClient();
      if (sb) {
        await sb.from("usage_log").insert({
          user_id: auth.userId,
          feature: feat,
          model: data.model || model,
          input_tokens: data.usage?.input_tokens ?? 0,
          output_tokens: data.usage?.output_tokens ?? 0,
        });
      }
    } catch (_) { /* swallow logging errors */ }

    return json({
      text,
      usage: data.usage || null,
      model: data.model || model,
    }, 200);
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
