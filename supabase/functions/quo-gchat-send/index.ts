// ─────────────────────────────────────────────────────────────────────────
// TMG App: Supabase Edge Function: quo-gchat-send
// Phase 2 of the Quo → Google Chat mirror: reply to a person by SMS from
// Google Chat. The "Quo Send" Chat app (Google Cloud project airy-gate-494616-g2,
// Chat API → Configuration) calls this when someone types, inside a person's
// thread in one of the Quo spaces:
//
//   /send See you at 3, thanks!
//
// and Quo texts that person from the space's own Quo line, as the sender.
//
// Which person and which line: quo-gchat (the mirror) saves every thread it
// posts to as threads/<space>__<thread>.json in the private "quo-gchat"
// storage bucket: { line, other }. A thread nobody has texted into since that
// started is not linked yet, and /send says so instead of guessing.
//
// Who may send: only people Quo itself allows on that line (matched by their
// TMG email), and the text goes out under their own Quo user. Nothing is ever
// sent without the explicit /send command.
//
// Auth: verify_jwt = false (Google is not a Supabase user). Every request
// must carry Google Chat's bearer token, checked against Google's keys with
// audience = the Cloud project number, so nobody else can trigger a send.
// Secrets: QUO_GCHAT_API_KEY (Quo API key), SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY (injected).
// ─────────────────────────────────────────────────────────────────────────

import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";

const PROJECT_NUMBER = "658084217796";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const JWKS = createRemoteJWKSet(new URL(`https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`));
const QUO = "https://api.openphone.com/v1";
const BUCKET = "quo-gchat";

const digits10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
const pretty = (d: string) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const HELP = "Reply inside a person's thread with `/send your message` and Quo texts it to them from this space's number.";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  try {
    const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    await jwtVerify(bearer, JWKS, { issuer: CHAT_ISSUER, audience: PROJECT_NUMBER });
  } catch (_) {
    return json({ error: "forbidden" }, 403);
  }

  let ev: any = {};
  try { ev = await req.json(); } catch (_) { /* ignore */ }
  // Only the person who typed /send sees the bot's answers.
  const reply = (text: string) => json(ev?.user?.name ? { privateMessageViewer: { name: ev.user.name }, text } : { text });

  if (ev.type === "ADDED_TO_SPACE") return json({ text: `Quo Send is here. ${HELP}` });
  if (ev.type !== "MESSAGE" && ev.type !== "APP_COMMAND") return json({});

  const msg = ev.message || {};
  const isSend = String(msg.slashCommand?.commandId ?? ev.appCommandMetadata?.appCommandId ?? "") === "1";
  if (!isSend) return reply(HELP);

  const text = String(msg.argumentText ?? "").trim();
  if (!text) return reply(`Nothing to send. ${HELP}`);
  if (text.length > 1600) return reply(`That is ${text.length} characters; Quo allows 1,600. Nothing was sent.`);

  // Which person this thread is with, and from which line.
  const thread = String(msg.thread?.name || "");
  const link = thread ? await readLink(thread) : null;
  if (!link) {
    return reply("This thread isn't linked to a phone number yet, so nothing was sent. Use /send inside a thread Quo started; older threads link the next time that person texts or calls.");
  }

  const key = Deno.env.get("QUO_GCHAT_API_KEY");
  if (!key) return reply("Quo Send isn't set up yet (missing Quo key). Nothing was sent.");
  const quo = (path: string, init: RequestInit = {}) =>
    fetch(QUO + path, { ...init, headers: { Authorization: key, "Content-Type": "application/json", ...(init.headers || {}) } });

  // Only people Quo allows on this line may send from it, as themselves.
  const pr = await quo("/phone-numbers");
  if (!pr.ok) return reply(`Couldn't reach Quo (${pr.status}). Nothing was sent.`);
  const pn = ((await pr.json()).data || []).find((p: any) => digits10(p.number) === link.line);
  if (!pn) return reply(`Quo line ${pretty(link.line)} wasn't found. Nothing was sent.`);
  const email = String(ev.user?.email || "").toLowerCase();
  const sender = (pn.users || []).find((u: any) => email && String(u.email || "").toLowerCase() === email);
  if (!sender) {
    console.log("[quo-gchat-send] not allowed on line", `…${link.line.slice(-4)}`, email ? "email given" : "no email on event");
    return reply(`Only people Quo allows on ${pretty(link.line)} can send from it. Nothing was sent.`);
  }

  const sr = await quo("/messages", {
    method: "POST",
    body: JSON.stringify({ content: text, from: pn.id, to: [`+1${link.other}`], userId: sender.id }),
  });
  if (!sr.ok) {
    const err = (await sr.text()).slice(0, 200);
    console.error("[quo-gchat-send] quo send failed", sr.status, err);
    return reply(`Quo refused it (${sr.status}). Nothing was sent.`);
  }
  console.log("[quo-gchat-send] sent", `…${link.line.slice(-4)} → …${link.other.slice(-4)}`);
  return reply(`Sent to ${pretty(link.other)} from ${pretty(link.line)}.`);
});

async function readLink(thread: string): Promise<{ line: string; other: string } | null> {
  const url = Deno.env.get("SUPABASE_URL"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return null;
  const r = await fetch(`${url}/storage/v1/object/${BUCKET}/${threadObject(thread)}`, { headers: { Authorization: `Bearer ${svc}` } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  const line = digits10(j?.line), other = digits10(j?.other);
  return line.length === 10 && other.length === 10 ? { line, other } : null;
}

// spaces/AAA/threads/BBB → threads/AAA__BBB.json (same rule as quo-gchat).
function threadObject(thread: string) {
  const m = thread.match(/^spaces\/([^/]+)\/threads\/([^/]+)$/);
  return m ? `threads/${m[1]}__${m[2]}.json` : `threads/${thread.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}
