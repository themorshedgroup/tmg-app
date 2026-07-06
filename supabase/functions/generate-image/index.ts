// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: generate-image
// Proxies OpenAI image generation so the API key never touches the browser.
//
// Deploy: Supabase Dashboard → Edge Functions → function `generate-image`
//   Paste this whole file, then click Deploy.
//
// Secret required (Dashboard → Edge Functions → Manage secrets):
//   OPENAI_API_KEY = <your OpenAI API key>
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// ── ACCESS CONTROL ─────────────────────────────────────────────────────
// Same gate as ai-chat: every request must carry a valid TMG user session
// (Authorization: Bearer <access_token>), and the caller's profiles.status
// must be 'active'. (verify_jwt stays OFF in the dashboard; we authorize
// in-code so the anon publishable key alone is not enough to call it.)
//
// Model is hard-coded to gpt-image-1.5 — this is a real per-call cost
// (unlike ai-chat's model, there's no ai_config dial for this one yet).
// ───────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const MODEL = "gpt-image-1.5";
// Fixed token counts OpenAI bills per 1024x1024 image, by quality — used only as a
// fallback for cost logging if the API response doesn't include a usage object.
const TOKENS_BY_QUALITY: Record<string, number> = { low: 272, medium: 1056, high: 4160 };

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key);
}

async function authorizeCaller(req: Request) {
  const sb = serviceClient();
  if (!sb) return { ok: false as const, status: 500, error: "Server auth not configured." };

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false as const, status: 401, error: "Sign in required." };

  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return { ok: false as const, status: 401, error: "Invalid or expired session." };

  const { data: profile, error: pErr } = await sb
    .from("profiles").select("status").eq("id", user.id).single();
  if (pErr || !profile) return { ok: false as const, status: 403, error: "Account pending approval." };
  if (profile.status !== "active") return { ok: false as const, status: 403, error: "Account is not active." };

  return { ok: true as const, userId: user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const auth = await authorizeCaller(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      return json({ error: "OPENAI_API_KEY not set in Supabase secrets." }, 500);
    }

    const body = await req.json().catch(() => ({}));
    const prompt = (typeof body.prompt === "string" ? body.prompt : "").trim().slice(0, 2000);
    if (!prompt) return json({ error: "Missing 'prompt'." }, 400);
    const quality = ["low", "medium", "high"].includes(body.quality) ? body.quality : "medium";

    const oaRes = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, prompt, size: "1024x1024", quality, n: 1 }),
    });

    const data = await oaRes.json().catch(() => ({}));
    if (!oaRes.ok) {
      return json({ error: data?.error?.message || "Image generation failed", detail: data }, oaRes.status);
    }

    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) return json({ error: "No image returned." }, 502);

    // Log cost per user (best-effort; never block the reply on logging).
    try {
      const sb = serviceClient();
      if (sb) {
        await sb.from("usage_log").insert({
          user_id: auth.userId,
          feature: "image-generation",
          model: MODEL,
          input_tokens: data.usage?.input_tokens ?? 0,
          output_tokens: data.usage?.output_tokens ?? TOKENS_BY_QUALITY[quality] ?? 1056,
        });
      }
    } catch (_) { /* swallow logging errors */ }

    return json({ b64 }, 200);
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
