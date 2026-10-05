// ─────────────────────────────────────────────────────────────────────────
// TMG App: Supabase Edge Function: quo-gchat
// Mirrors Ops team Quo lines into private Google Chat spaces, one space per
// line and one thread per outside phone number. Read-only (Phase 1): nothing
// is ever sent by SMS here.
//
//   Quo webhook (texts, calls, voicemails) → this function → Google Chat
//   incoming webhook of the space that belongs to that Quo line.
//
// Deploy: verify_jwt = false (Quo is not a Supabase user). The caller must
// include ?t=<token>; only the token's SHA-256 is stored here (the repo is
// public), the token itself lives in the Quo webhook URL and ~/.quo-gchat.
//
// Routing: LINES maps a Quo line (10 digits) to the secret holding its space's
// incoming-webhook URL (pasted by Symon, never printed). A line that is not in
// LINES, or whose secret is missing, is skipped and logged by its last 4
// digits only, so nobody's texts ever land in someone else's space.
//
// What gets posted:
//   message.received / message.delivered → the text (photos noted, not copied)
//   call.completed                       → one line: in/out, missed, length
//   call.summary.completed               → Quo's AI summary + next steps
//   call.voicemail.completed             → the full voicemail transcript
//   call.transcript.completed            → only when it is a voicemail (nobody
//                                          on our side spoke); regular call
//                                          transcripts are not mirrored
// Both voicemail paths share requestId vm-<callId>, so one voicemail posts once.
//
// Threads: threadKey = the other party's 10-digit number, so every text and
// call with the same person lands in the same thread. requestId = Quo's id, so
// a Quo retry of the same event never posts twice.
// ─────────────────────────────────────────────────────────────────────────

const TOKEN_SHA256 = "d00c4d11eb0dd4ce20295cdc7c66f2a19d20ca4bbe8395e4c2a75673aea77a3f";

// Quo line → secret of the Chat space it posts to. Shared lines are flagged
// so outgoing texts read "Sent" instead of "You".
const LINES: Record<string, { secret: string; shared?: boolean }> = {
  "5126436688": { secret: "GCHAT_TEXTS_WEBHOOK" },            // Symon → "TMG SMS"
  "5126101095": { secret: "GCHAT_WEBHOOK_MAINLINE", shared: true }, // main line → "TMG Main Line"
  "5128314911": { secret: "GCHAT_WEBHOOK_ALEXANDRA" },       // → "Quo - Alexandra"
  "5129803161": { secret: "GCHAT_WEBHOOK_CAMILA" },          // → "Quo - Camila"
  "5126101096": { secret: "GCHAT_WEBHOOK_ANGELICA" },        // → "Quo - Angelica"
  "5129001113": { secret: "GCHAT_WEBHOOK_GUSTAVO" },         // → "Quo - Gustavo"
};

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const digits10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
const pretty = (d: string) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || "unknown number");
const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
const mins = (s: unknown) => {
  const n = Math.round(Number(s) || 0);
  return n >= 60 ? `${Math.floor(n / 60)}m ${n % 60}s` : `${n}s`;
};

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const t = new URL(req.url).searchParams.get("t") || "";
  if ((await sha256(t)) !== TOKEN_SHA256) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });

  // Always answer 200 so Quo never retry-storms a bad event (see sffu-inbound).
  try {
    let payload: any = {};
    try { payload = await req.json(); } catch (_) { /* ignore */ }
    const evt = String(payload?.type || "").toLowerCase();
    const m = payload?.data?.object || payload?.data?.resource || {};
    const ctx = payload?.data?.context || {};
    const parts = ctx.participants || {};
    const deepLink = typeof payload?.data?.links?.quo === "string" ? payload.data.links.quo : "";

    // Work out which of our lines this is about, and who is on the other end.
    // Trust the event type, not message.direction (unreliable on this account).
    let ourLine = "", other = "", outbound = false;
    if (evt === "message.received" || evt === "message.delivered") {
      outbound = evt === "message.delivered";
      const fromN = digits10(m.from || ctx.senderIdentifier);
      const toN = digits10(first(m.to) || first(ctx.recipientIdentifiers));
      ourLine = outbound ? fromN : toN;
      other = outbound ? toN : fromN;
    } else if (evt.startsWith("call.")) {
      outbound = m.direction === "outgoing";
      if (first(parts.workspace)) {
        ourLine = digits10(first(parts.workspace));
        other = digits10(first(parts.external));
      } else {
        // Older payloads and voicemails: from/to on the call itself. A
        // voicemail has no direction and is always outside caller → our line.
        const fromN = digits10(m.from), toN = digits10(first(m.to));
        ourLine = outbound ? fromN : toN;
        other = outbound ? toN : fromN;
      }
    } else {
      return ok({ ignored: evt || "no type" });
    }
    if (!other) return ok({ ignored: "no phone number on payload" });

    const line = LINES[ourLine];
    if (!line) {
      console.log("[quo-gchat] skipped: line not mapped", `…${ourLine.slice(-4) || "none"}`, evt);
      return ok({ ignored: "line not mapped" });
    }
    const hook = Deno.env.get(line.secret);
    if (!hook) return ok({ ignored: `${line.secret} not set` });

    // Build the message for this event.
    let text = "", requestId = "";
    if (evt.startsWith("message.")) {
      let body = String(m.body ?? m.text ?? m.content ?? "").trim();
      const media = Array.isArray(m.media) ? m.media.length : 0;
      if (media) body = `${body}${body ? "\n" : ""}[${media} photo${media > 1 ? "s" : ""}/file${media > 1 ? "s" : ""}, open Quo to view]`;
      if (!body) body = "[empty message]";
      const head = outbound ? `📤 *${line.shared ? "Sent" : "You"} → ${pretty(other)}*` : `📥 *${pretty(other)}*`;
      text = `${head}\n${body}`;
      if (m.id) requestId = `quo-${m.id}`;
    } else if (evt === "call.completed") {
      const status = String(m.status || "").toLowerCase();
      const missed = /miss|no-answer|unanswered|abandon|busy|fail|cancel/.test(status) || (!outbound && !m.answeredAt && !Number(m.duration));
      const label = missed
        ? (outbound ? "📞 Unanswered call to" : "📞 Missed call from")
        : (outbound ? `📞 Call to` : `📞 Call from`);
      text = `${label} *${pretty(other)}*${missed ? "" : ` (${mins(m.duration)})`}`;
      if (m.id) requestId = `call-${m.id}`;
    } else if (evt === "call.summary.completed") {
      const summary = (Array.isArray(m.summary) ? m.summary : [m.summary]).filter(Boolean).map((s: unknown) => `• ${s}`);
      const steps = (Array.isArray(m.nextSteps) ? m.nextSteps : [m.nextSteps]).filter(Boolean).map((s: unknown) => `• ${s}`);
      if (!summary.length && !steps.length) return ok({ ignored: "empty summary" });
      text = `📝 *Call summary, ${pretty(other)}*`;
      if (summary.length) text += `\n${summary.join("\n")}`;
      if (steps.length) text += `\n*Next steps*\n${steps.join("\n")}`;
      if (m.callId) requestId = `sum-${m.callId}`;
    } else if (evt === "call.voicemail.completed" || evt === "call.transcript.completed") {
      let transcript = "";
      if (evt === "call.voicemail.completed") {
        transcript = String(m.transcript ?? m.transcription ?? "").trim();
      } else {
        // A call transcript where only the outside caller spoke is a voicemail.
        const lines = Array.isArray(m.dialogue) ? m.dialogue : [];
        const oursSpoke = lines.some((d: any) => d?.userId || (d?.identifier && digits10(d.identifier) === ourLine));
        if (!lines.length || oursSpoke) return ok({ ignored: "call transcript (not a voicemail)" });
        transcript = lines.map((d: any) => String(d?.content ?? "").trim()).filter(Boolean).join(" ");
      }
      text = `🎙️ *Voicemail from ${pretty(other)}*${m.duration ? ` (${mins(m.duration)})` : ""}\n${transcript || "[no transcript yet, open Quo to listen]"}`;
      const callId = m.callId || m.id;
      if (callId) requestId = `vm-${callId}`;
    } else {
      return ok({ ignored: evt });
    }
    if (deepLink && !evt.startsWith("message.")) text += `\n<${deepLink}|Open in Quo>`;

    const url = new URL(hook);
    url.searchParams.set("threadKey", `sms-${other}`);
    url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    if (requestId) url.searchParams.set("requestId", requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60));

    const post = () => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text }),
    });
    let r = await post();
    // Some spaces' webhooks refuse requestId ("Request Id is not supported for
    // webhooks"). Post again without it rather than lose the message.
    if (r.status === 400 && url.searchParams.has("requestId")) {
      const err = await r.text();
      if (!/request ?id/i.test(err)) {
        console.error("[quo-gchat] chat post failed", r.status, err.slice(0, 300));
        return ok({ posted: false, evt });
      }
      url.searchParams.delete("requestId");
      r = await post();
    }
    if (!r.ok) console.error("[quo-gchat] chat post failed", r.status, (await r.text()).slice(0, 300));
    return ok({ posted: r.ok, evt });
  } catch (e) {
    console.error("[quo-gchat] error", String(e));
    return ok({ error: "handled" });
  }
});
