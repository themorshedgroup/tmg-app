// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: sffu-sender
// Showings Follow-Up automated SMS sender. Runs every 30 min (pg_cron calls it).
// Reads DUE showings from the SFFU app's own tables, renders the correct touch
// template, sends via Quo, logs to sms_messages, and advances the schedule.
// This REPLACES the old self-hosted n8n "Sender" workflow.
//
// Deploy: Supabase Dashboard → Edge Functions → new function `sffu-sender`
//   → paste this whole file → Deploy. (Leave "Verify JWT" ON — the cron sends
//   the CRON_SECRET; see auth check below.)
//
// Secrets (Dashboard → Edge Functions → Manage secrets):
//   CRON_SECRET     = <a long random string; put the SAME value in sffu-cron.sql>
//   QUO_API_KEY     = <your Quo API key>
//   QUO_FROM_NUMBER = <your Quo sending number in E.164, e.g. +15125550123>
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// Timing: a new showing defaults next_touch_at = now() → touch 1 on the next
// run (immediate, whatever time the showing was logged), then +24h → touch 2
// (Day 2), +24h → touch 3 (Day 3), then done. Touches 2 and 3 are clamped to
// an 8:00 AM–5:00 PM America/Chicago window (touch 1 is not — it's meant to
// go out right away) — see clampToBusinessWindow below.
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

// Fill the app's template placeholders, same as the app's renderTemplate().
function fill(body: string, s: any): string {
  const agentFirst = (s.agent_name || "").split(" ")[0] || "there";
  const address = s.property_address || "";
  const myName = (s.added_by_name || "").split(" ")[0] || "The Morshed Group";
  const listingAgent = s.listing_agent || "our team";
  const zillowUrl = s.zillow_url || "";
  return (body || "")
    .replace(/\{\{\s*agent_first_name\s*\}\}/g, agentFirst)
    .replace(/\{\{\s*address\s*\}\}/g, address)
    .replace(/\{\{\s*my_name\s*\}\}/g, myName)
    .replace(/\{\{\s*listing_agent\s*\}\}/g, listingAgent)
    .replace(/\{\{\s*zillow_url\s*\}\}/g, zillowUrl);
}

// ── America/Chicago business-hours clamp (touches 2 & 3 only) ──────────────
// The UTC offset for America/Chicago at a given instant — -360 (CST) or -300
// (CDT) — read via Intl rather than hardcoded, so DST transitions self-correct.
function centralOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", timeZoneName: "shortOffset" }).formatToParts(at);
  const tz = parts.find((p) => p.type === "timeZoneName")?.value || "GMT-6";
  const m = tz.match(/GMT([+-]\d+)(?::(\d+))?/);
  const h = m ? parseInt(m[1], 10) : -6;
  const mins = m && m[2] ? parseInt(m[2], 10) : 0;
  return h * 60 + (h < 0 ? -mins : mins);
}
// The wall-clock date/time `at` reads as in America/Chicago.
function centralParts(at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago", hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(at).map((p) => [p.type, p.value])
  );
  const hour = Number(parts.hour) === 24 ? 0 : Number(parts.hour); // Intl can render midnight as "24"
  return { y: Number(parts.year), m: Number(parts.month), day: Number(parts.day), hour, minute: Number(parts.minute) };
}
// The UTC instant corresponding to a specific America/Chicago wall-clock date+time.
function centralToUTC(y: number, m: number, day: number, hour: number, minute: number): Date {
  const guess = new Date(Date.UTC(y, m - 1, day, hour + 6, minute)); // seed assuming CST, then refine
  const offMin = centralOffsetMinutes(guess);
  return new Date(Date.UTC(y, m - 1, day, hour, minute) - offMin * 60000);
}
// Pushes a candidate send time into the 8:00 AM–5:00 PM Central window: same-day
// 8:00 AM if it lands before 8am, next-day 8:00 AM if it lands at/after 5pm.
function clampToBusinessWindow(candidate: Date): Date {
  const p = centralParts(candidate);
  if (p.hour >= 8 && p.hour < 17) return candidate;
  if (p.hour < 8) return centralToUTC(p.y, p.m, p.day, 8, 0);
  const nextDay = new Date(Date.UTC(p.y, p.m - 1, p.day + 1));
  return centralToUTC(nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate(), 8, 0);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // Only the scheduled cron (which knows CRON_SECRET) may run this.
  const secret = Deno.env.get("CRON_SECRET") || "";
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || auth !== secret) return json({ error: "unauthorized" }, 401);

  const sb = serviceClient();
  if (!sb) return json({ error: "server not configured" }, 500);

  const QUO_KEY = Deno.env.get("QUO_API_KEY");
  const QUO_FROM = Deno.env.get("QUO_FROM_NUMBER");
  if (!QUO_KEY || !QUO_FROM) return json({ error: "Quo secrets missing" }, 500);

  // 1) Templates (touch 1..3 + the "Reply Received" ack) + property →
  // listing-agent lookup + sender name from settings. Loaded up front,
  // unconditionally — both the regular touch-sender (step 2) and the
  // reply-ack sender (step 3) need these, and step 3 must run even on a
  // cycle where nothing is due for a regular touch (see the removed early
  // return below: it used to skip step 3 entirely whenever `due` was empty,
  // which meant a queued "Reply Received" ack silently never sent unless
  // another showing happened to have a regular touch due in the very same
  // 30-min window — confirmed via live data as the cause of acks sitting
  // unsent for days).
  const { data: tpls } = await sb.from("sms_templates").select("touch_number, body").order("touch_number");
  const tplByTouch: Record<number, string> = {};
  (tpls || []).forEach((t: any) => { tplByTouch[t.touch_number] = t.body; });

  const { data: props } = await sb.from("properties").select("address, listing_agent, zillow_url");
  const agentByAddr: Record<string, string> = {};
  const urlByAddr: Record<string, string> = {};
  (props || []).forEach((p: any) => {
    if (p.address) { agentByAddr[p.address] = p.listing_agent; urlByAddr[p.address] = p.zillow_url; }
  });

  // 2) Due showings (regular touch sequence).
  const { data: due, error: dueErr } = await sb
    .from("showings")
    .select("id, agent_name, agent_phone, property_address, added_by_name, touch_count")
    .eq("followup_status", "active")
    .not("next_touch_at", "is", null)
    .lte("next_touch_at", new Date().toISOString())
    .not("agent_phone", "is", null)
    .limit(25);
  if (dueErr) return json({ error: dueErr.message }, 500);

  let sent = 0;
  const errors: any[] = [];
  for (const s of due || []) {
    const touch = (s.touch_count || 0) + 1; // 1, 2, or 3
    const body = tplByTouch[touch];
    if (!body) continue;
    (s as any).listing_agent = agentByAddr[s.property_address] || null;
    (s as any).zillow_url = urlByAddr[s.property_address] || null;
    const content = fill(body, s);

    // 3) Send via Quo. (If you get 401, change the header to `Bearer ${QUO_KEY}`.)
    let quoId: string | null = null;
    let quoStatus = "sent";
    let quoConversationId: string | null = null;
    try {
      const r = await fetch("https://api.quo.com/v1/messages", {
        method: "POST",
        headers: { "Authorization": QUO_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: QUO_FROM, to: [s.agent_phone], content }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { errors.push({ id: s.id, status: r.status, quo: data }); continue; }
      quoId = data?.data?.id ?? null;
      quoStatus = data?.data?.status ?? "sent";
      quoConversationId = data?.data?.conversationId ?? null;
    } catch (e) {
      errors.push({ id: s.id, error: String(e) });
      continue;
    }

    // 4) Log the outbound + advance the schedule. Stamp the showing with
    // Quo's conversationId so sffu-inbound can match replies precisely
    // (the sending number is shared across team members, so phone-number
    // matching alone can't tell a real reply apart from unrelated texting
    // on the same number).
    await sb.from("sms_messages").insert({
      showing_id: s.id, direction: "out", touch_number: touch, body: content,
      quo_message_id: quoId, quo_conversation_id: quoConversationId,
      status: quoStatus, sent_by_name: "Auto · SFFU",
    });
    const done = touch >= 3;
    // 24h after this touch, then held to 8am-5pm Central if that lands outside it
    // (touch 1 itself is never clamped — it's meant to go out immediately).
    const nextTouchAt = done ? null : clampToBusinessWindow(new Date(Date.now() + 24 * 3600 * 1000));
    const showingUpdate: Record<string, unknown> = {
      touch_count: touch,
      next_touch_at: nextTouchAt ? nextTouchAt.toISOString() : null,
      followup_status: done ? "completed" : "active",
    };
    if (quoConversationId) showingUpdate.quo_conversation_id = quoConversationId;
    await sb.from("showings").update(showingUpdate).eq("id", s.id);
    sent++;
  }

  // 5) "Thanks for the feedback!" auto-ack — queued by sffu-inbound the
  // moment a genuine (non-STOP) reply comes in, for showings that haven't
  // already gotten one. Uses the same send path + template 4 ("Reply
  // Received" in Settings). Runs on this same 30-min cron, unconditionally
  // (see the note on step 1) — no separate scheduled job needed for this.
  const { data: pendingAcks, error: ackErr } = await sb
    .from("showings")
    .select("id, agent_name, agent_phone, property_address, added_by_name")
    .eq("reply_ack_pending", true)
    .not("agent_phone", "is", null)
    .limit(25);
  let acksSent = 0;
  const ackErrors: any[] = [];
  if (ackErr) ackErrors.push({ error: ackErr.message });
  const ackBody = tplByTouch[4];
  for (const s of pendingAcks || []) {
    if (!ackBody) break; // no "Reply Received" template configured yet
    (s as any).listing_agent = agentByAddr[s.property_address] || null;
    (s as any).zillow_url = urlByAddr[s.property_address] || null;
    const content = fill(ackBody, s);
    let quoId: string | null = null;
    let quoStatus = "sent";
    let quoConversationId: string | null = null;
    try {
      const r = await fetch("https://api.quo.com/v1/messages", {
        method: "POST",
        headers: { "Authorization": QUO_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ from: QUO_FROM, to: [s.agent_phone], content }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { ackErrors.push({ id: s.id, status: r.status, quo: data }); continue; }
      quoId = data?.data?.id ?? null;
      quoStatus = data?.data?.status ?? "sent";
      quoConversationId = data?.data?.conversationId ?? null;
    } catch (e) {
      ackErrors.push({ id: s.id, error: String(e) });
      continue;
    }
    await sb.from("sms_messages").insert({
      showing_id: s.id, direction: "out", touch_number: 4, body: content,
      quo_message_id: quoId, quo_conversation_id: quoConversationId,
      status: quoStatus, sent_by_name: "Auto · SFFU",
    });
    await sb.from("showings").update({ reply_ack_pending: false, reply_ack_sent: true }).eq("id", s.id);
    acksSent++;
  }

  return json({ sent, due: (due || []).length, errors, acksSent, ackErrors });
});
