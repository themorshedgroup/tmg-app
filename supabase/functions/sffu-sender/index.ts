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
// run, then +2 days → touch 2 (Day 3), +2 days → touch 3 (Day 5), then done.
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
  return (body || "")
    .replace(/\{\{\s*agent_first_name\s*\}\}/g, agentFirst)
    .replace(/\{\{\s*address\s*\}\}/g, address)
    .replace(/\{\{\s*my_name\s*\}\}/g, myName)
    .replace(/\{\{\s*listing_agent\s*\}\}/g, listingAgent);
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

  // 1) Due showings.
  const { data: due, error: dueErr } = await sb
    .from("showings")
    .select("id, agent_name, agent_phone, property_address, added_by_name, touch_count")
    .eq("followup_status", "active")
    .not("next_touch_at", "is", null)
    .lte("next_touch_at", new Date().toISOString())
    .not("agent_phone", "is", null)
    .limit(25);
  if (dueErr) return json({ error: dueErr.message }, 500);
  if (!due || due.length === 0) return json({ sent: 0, note: "nothing due" });

  // 2) Templates (touch 1..3) + property → listing-agent lookup + sender name from settings.
  const { data: tpls } = await sb.from("sms_templates").select("touch_number, body").order("touch_number");
  const tplByTouch: Record<number, string> = {};
  (tpls || []).forEach((t: any) => { tplByTouch[t.touch_number] = t.body; });

  const { data: props } = await sb.from("properties").select("address, listing_agent");
  const agentByAddr: Record<string, string> = {};
  (props || []).forEach((p: any) => { if (p.address) agentByAddr[p.address] = p.listing_agent; });


  let sent = 0;
  const errors: any[] = [];
  for (const s of due) {
    const touch = (s.touch_count || 0) + 1; // 1, 2, or 3
    const body = tplByTouch[touch];
    if (!body) continue;
    (s as any).listing_agent = agentByAddr[s.property_address] || null;
    const content = fill(body, s);

    // 3) Send via Quo. (If you get 401, change the header to `Bearer ${QUO_KEY}`.)
    let quoId: string | null = null;
    let quoStatus = "sent";
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
    } catch (e) {
      errors.push({ id: s.id, error: String(e) });
      continue;
    }

    // 4) Log the outbound + advance the schedule.
    await sb.from("sms_messages").insert({
      showing_id: s.id, direction: "out", touch_number: touch, body: content,
      quo_message_id: quoId, status: quoStatus, sent_by_name: "Auto · SFFU",
    });
    const done = touch >= 3;
    await sb.from("showings").update({
      touch_count: touch,
      next_touch_at: done ? null : new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString(),
      followup_status: done ? "completed" : "active",
    }).eq("id", s.id);
    sent++;
  }

  return json({ sent, due: due.length, errors });
});
