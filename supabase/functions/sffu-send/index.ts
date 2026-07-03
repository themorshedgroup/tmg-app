// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: sffu-send
// Sends a MANUAL one-off text from a showing's conversation thread (when a TC
// types a message and hits send) — via Quo, then logs it to sms_messages so it
// shows in the thread. The automated Day 1/3/5 texts use `sffu-sender` instead.
//
// Deploy: Edge Functions → new function `sffu-send` → paste → Deploy.
//   Leave "Verify JWT" ON (the app sends the signed-in user's token).
// Secrets: reuses QUO_API_KEY + QUO_FROM_NUMBER (already set for sffu-sender).
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY injected automatically.)
//
// Request (from the app):  POST { showing_id, body }  with the user's
//   Authorization: Bearer <session token>.
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const sb = serviceClient();
  if (!sb) return json({ error: "server not configured" }, 500);

  // Require a signed-in user (their session token).
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const { data: ures } = await sb.auth.getUser(token);
  if (!ures?.user) return json({ error: "unauthorized" }, 401);
  const senderName = ures.user.user_metadata?.full_name || ures.user.email || "TMG";

  const QUO_KEY = Deno.env.get("QUO_API_KEY");
  const QUO_FROM = Deno.env.get("QUO_FROM_NUMBER");
  if (!QUO_KEY || !QUO_FROM) return json({ error: "Quo secrets missing" }, 500);

  let payload: any = {};
  try { payload = await req.json(); } catch (_) { /* ignore */ }
  const showingId = payload.showing_id;
  const body = (payload.body || "").toString().trim();
  if (!showingId || !body) return json({ error: "missing showing_id or body" }, 400);

  // Look up the showing's phone (the buyer's agent).
  const { data: s, error: sErr } = await sb
    .from("showings").select("id, agent_phone").eq("id", showingId).maybeSingle();
  if (sErr) return json({ error: sErr.message }, 500);
  if (!s?.agent_phone) return json({ error: "no phone on this showing" }, 400);

  // Send via Quo. (If you get 401, change the header to `Bearer ${QUO_KEY}`.)
  let quoId: string | null = null;
  let quoStatus = "sent";
  let quoConversationId: string | null = null;
  try {
    const r = await fetch("https://api.quo.com/v1/messages", {
      method: "POST",
      headers: { "Authorization": QUO_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: QUO_FROM, to: [s.agent_phone], content: body }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "Quo send failed", status: r.status, quo: data }, 502);
    quoId = data?.data?.id ?? null;
    quoStatus = data?.data?.status ?? "sent";
    quoConversationId = data?.data?.conversationId ?? null;
  } catch (e) {
    return json({ error: "Quo request error: " + String(e) }, 502);
  }

  // Log it to the thread. Stamp the showing with Quo's conversationId (see
  // sffu-inbound) so a reply matches precisely even though the sending
  // number is shared across team members.
  const { error: insErr } = await sb.from("sms_messages").insert({
    showing_id: showingId, direction: "out", touch_number: null, body,
    quo_message_id: quoId, quo_conversation_id: quoConversationId,
    status: quoStatus, sent_by_name: senderName,
  });
  if (quoConversationId) {
    await sb.from("showings").update({ quo_conversation_id: quoConversationId }).eq("id", showingId);
  }
  if (insErr) return json({ ok: true, sent: true, logWarning: insErr.message });

  return json({ ok: true, sent: true });
});
