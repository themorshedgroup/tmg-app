// ─────────────────────────────────────────────────────────────────────────
// TMG App: Supabase Edge Function: quo-gchat
// Mirrors Symon's own Quo line into a private Google Chat space, one thread
// per phone number. Read-only (Phase 1): nothing is ever sent by SMS here.
//
//   Quo webhook (message.received + message.delivered, scoped in Quo's UI to
//   Symon's line only) → this function → Google Chat incoming webhook.
//
// Deploy: verify_jwt = false (Quo is not a Supabase user). The caller must
// include ?t=<token>; only the token's SHA-256 is stored here (the repo is
// public), the token itself lives in the Quo webhook URL and ~/.quo-gchat.
//
// Secret: GCHAT_TEXTS_WEBHOOK = the space's incoming-webhook URL (set by
// Symon himself, never printed).
//
// Threads: threadKey = the other party's 10-digit number, so every text with
// the same person lands in the same thread. requestId = Quo's message id, so
// a Quo retry of the same event never posts twice.
// ─────────────────────────────────────────────────────────────────────────

const TOKEN_SHA256 = "d00c4d11eb0dd4ce20295cdc7c66f2a19d20ca4bbe8395e4c2a75673aea77a3f";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const digits10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
const pretty = (d: string) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d || "unknown number");

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const t = new URL(req.url).searchParams.get("t") || "";
  if ((await sha256(t)) !== TOKEN_SHA256) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });

  const hook = Deno.env.get("GCHAT_TEXTS_WEBHOOK");
  if (!hook) return ok({ ignored: "GCHAT_TEXTS_WEBHOOK not set" });

  // Always answer 200 so Quo never retry-storms a bad event (see sffu-inbound).
  try {
    let payload: any = {};
    try { payload = await req.json(); } catch (_) { /* ignore */ }
    const evt = String(payload?.type || "").toLowerCase();
    // Trust the event type, not message.direction (unreliable on this account).
    const inbound = evt === "message.received";
    const outbound = evt === "message.delivered";
    if (!inbound && !outbound) return ok({ ignored: evt || "no type" });

    const m = payload?.data?.object || payload?.data?.resource || {};
    const ctx = payload?.data?.context || {};
    const fromN = digits10(m.from || ctx.senderIdentifier);
    const toRaw = Array.isArray(m.to) ? m.to[0] : (m.to || (ctx.recipientIdentifiers || [])[0]);
    const other = inbound ? fromN : digits10(toRaw);
    if (!other) return ok({ ignored: "no phone number on payload" });

    let body = String(m.body ?? m.text ?? m.content ?? "").trim();
    const media = Array.isArray(m.media) ? m.media.length : 0;
    if (media) body = `${body}${body ? "\n" : ""}[${media} photo${media > 1 ? "s" : ""}/file${media > 1 ? "s" : ""}, open Quo to view]`;
    if (!body) body = "[empty message]";

    const head = inbound ? `📥 *${pretty(other)}*` : `📤 *You → ${pretty(other)}*`;
    const url = new URL(hook);
    url.searchParams.set("threadKey", `sms-${other}`);
    url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    if (m.id) url.searchParams.set("requestId", `quo-${m.id}`);

    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({ text: `${head}\n${body}` }),
    });
    if (!r.ok) console.error("[quo-gchat] chat post failed", r.status, (await r.text()).slice(0, 300));
    return ok({ posted: r.ok, dir: inbound ? "in" : "out" });
  } catch (e) {
    console.error("[quo-gchat] error", String(e));
    return ok({ error: "handled" });
  }
});
