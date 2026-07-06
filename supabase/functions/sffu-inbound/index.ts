// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: sffu-inbound
// Receives Quo "incoming message" webhooks: logs the reply to the showing's
// thread (sms_messages) and STOPS that showing's follow-up sequence.
// Replaces the old self-hosted n8n "Inbound" workflow.
//
// Deploy: Supabase Dashboard → Edge Functions → new function `sffu-inbound`
//   → paste this whole file → Deploy.
//   IMPORTANT: turn OFF "Verify JWT" for this function (it's a public webhook
//   Quo calls — there's no Supabase user). We validate a shared token instead.
//
// Secrets:
//   QUO_WEBHOOK_TOKEN = <optional shared token; if set, the webhook URL must
//                        include ?token=THAT_VALUE, else the call is rejected>
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY injected automatically.)
//
// In Quo: Settings → API/Webhooks → add a webhook for message events pointing
// at:  https://<ref>.supabase.co/functions/v1/sffu-inbound?token=<TOKEN>
// Can (and should) subscribe to ALL numbers (resourceIds:["*"]) — matching
// is by Quo's conversationId, not by phone number, so it's safe even when
// the sending number is shared across multiple team members (see below).
//
// Payload shape: Quo (formerly OpenPhone) sends the message at
// payload.data.object (canonical) — {from, to, body, id, direction,
// conversationId} as plain strings, direction "incoming"/"outgoing" — or,
// per a newer/typed variant, at payload.data.resource with phone numbers
// under payload.data.context (senderIdentifier / recipientIdentifiers[]).
// We read both. Top-level `type` is "message.received" for inbound,
// "message.delivered"/"failed" for outbound status events.
//
// Matching: by Quo's conversationId, NOT phone number — see sffu-sender /
// sffu-send, which stamp `showings.quo_conversation_id` on every send.
// A reply only ever attributes to a showing if it's in that exact Quo
// conversation; there's no phone-number fallback (see 2026-07-03 incident:
// phone-only matching swept unrelated team texting into showing threads
// because the sending number is assigned to multiple people).
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
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

  // Optional shared-token gate (?token=...).
  const wantToken = Deno.env.get("QUO_WEBHOOK_TOKEN");
  if (wantToken) {
    const got = new URL(req.url).searchParams.get("token");
    if (got !== wantToken) return json({ error: "forbidden" }, 403);
  }

  const sb = serviceClient();
  if (!sb) return json({ error: "server not configured" }, 500);

  // Never let a malformed/unexpected payload throw → 500 → Quo retry-storm.
  // Any failure below is caught and logged, and we still answer 200 so Quo
  // doesn't keep re-delivering the same event.
  try {
    let payload: any = {};
    try { payload = await req.json(); } catch (_) { /* ignore */ }

    // Quo's payload shape can vary; pull the message object defensively.
    // data.object = canonical (v2) shape; data.resource = alternate/typed shape.
    const m = payload?.data?.object || payload?.data?.resource || payload?.data?.message
      || payload?.data || payload?.message || payload || {};
    const ctx = payload?.data?.context || {};
    const from = m.from || m.from_number || m.sender || m.participant || ctx.senderIdentifier || "";
    const text = m.text ?? m.body ?? m.content ?? m.message ?? "";
    const quoId = m.id || m.message_id || null;
    const conversationId = m.conversationId || m.conversation_id || null;

    // Distinguish an inbound reply from our OWN outbound (Quo also fires
    // webhooks for messages we send + delivery-status events). Trust the
    // top-level event `type` alone — it's Quo's authoritative "this is a
    // genuine inbound message" signal ("message.received" fires only for
    // incoming messages, per Quo's own event docs). The per-message
    // `direction` field is NOT a reliable second signal in practice — real
    // payloads from this account show direction:"outgoing" on messages that
    // are unambiguously inbound replies (confirmed via conversationId +
    // sender + body match on a live test), so it must not be checked.
    const evtType = String(payload?.type || "").toLowerCase();
    const typeSaysOutbound = evtType ? evtType !== "message.received" : false;
    if (typeSaysOutbound) {
      return json({ ignored: "outbound / status event, not an inbound reply" });
    }

    // Match by Quo's conversationId — NOT phone number. The sending number
    // is shared across multiple team members, so "sender's number matches
    // some showing's agent_phone" isn't a reliable signal (it previously
    // swept ~28 unrelated team-texting messages into showing threads).
    // conversationId is stamped on the showing the moment we send it a
    // touch (sffu-sender / sffu-send), so only a reply within THAT specific
    // conversation can ever match. No conversationId → no fallback guessing.
    if (!conversationId) return json({ ignored: "no conversationId on payload" });
    const { data: hit } = await sb
      .from("showings")
      .select("id, agent_name, followup_status, reply_ack_sent")
      .eq("quo_conversation_id", conversationId)
      .maybeSingle();
    if (!hit) return json({ ok: true, matched: false, note: "no showing for this conversation" });

    // Log the reply into the showing's thread.
    await sb.from("sms_messages").insert({
      showing_id: hit.id, direction: "in", body: text, quo_message_id: quoId,
      quo_conversation_id: conversationId, status: "received", sent_by_name: hit.agent_name || from,
    });

    // Stop the sequence. STOP/UNSUBSCRIBE → opted out; otherwise mark received
    // (but never un-stop a showing the agent previously opted out of).
    const isStop = /^\s*(stop|unsubscribe|cancel|quit|end)\b/i.test(String(text));
    const newStatus = isStop ? "stopped" : (hit.followup_status === "stopped" ? "stopped" : "received");
    // Queue the "Reply Received" auto-ack (sent by sffu-sender's existing
    // cron) — but only once per showing, ever: any reply counts as
    // feedback, but a STOP doesn't deserve a "thanks for the feedback!",
    // and a second/third reply in the same conversation shouldn't get
    // thanked again now that the first one already has been.
    const showingUpdate: Record<string, unknown> = { followup_status: newStatus, next_touch_at: null };
    if (!isStop && !hit.reply_ack_sent) showingUpdate.reply_ack_pending = true;
    await sb.from("showings").update(showingUpdate).eq("id", hit.id);

    return json({ ok: true, matched: true, showing_id: hit.id });
  } catch (e) {
    console.error("[sffu-inbound] unhandled error:", e);
    return json({ ok: false, error: "internal error, logged" }, 200);
  }
});
