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
// Delivery: Quo accepting a text is not the carrier delivering it. For two
// minutes after each send this looks the message up again, and if Quo marks
// it undelivered it posts a warning in the person's thread (through the same
// space webhook the mirror uses), since otherwise the only sign is a 📤 line
// that never comes.
//
// Photos and files: Quo's API sends text only. If /send carries an
// attachment, the words still go and the private reply says the file did not.
//
// Secrets: QUO_GCHAT_API_KEY (Quo API key), the GCHAT_* space webhooks
// (shared with quo-gchat), SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (injected).
// ─────────────────────────────────────────────────────────────────────────

import { createRemoteJWKSet, jwtVerify } from "npm:jose@5.9.6";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const PROJECT_NUMBER = "658084217796";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const JWKS = createRemoteJWKSet(new URL(`https://www.googleapis.com/service_accounts/v1/jwk/${CHAT_ISSUER}`));
const QUO = "https://api.openphone.com/v1";
const BUCKET = "quo-gchat";

// Quo line → secret holding its space's incoming webhook. Same map as quo-gchat.
// Group replies are new: only these people may /send into a group thread
// until a live test shows Quo delivers it as one group text.
const GROUP_SEND_TESTERS = ["manager@themorshedgroup.com"];

const LINES: Record<string, string> = {
  "5126436688": "GCHAT_TEXTS_WEBHOOK",
  "5126101095": "GCHAT_WEBHOOK_MAINLINE",
  "5128314911": "GCHAT_WEBHOOK_ALEXANDRA",
  "5129803161": "GCHAT_WEBHOOK_CAMILA",
  "5126101096": "GCHAT_WEBHOOK_ANGELICA",
  "5129001113": "GCHAT_WEBHOOK_GUSTAVO",
};

const digits10 = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
const pretty = (d: string) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const HELP = "Reply inside a person's thread with `/send your message` and Quo sends it to them by SMS from this space's number.";

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

  // A crash used to leave the thread silent (2026-10-06): say so instead.
  try {
    return await handle(ev, reply);
  } catch (e) {
    console.error("[quo-gchat-send] crashed", String(e).slice(0, 300));
    return reply(`Quo Send hit an error (${String(e).slice(0, 120)}). Check the Quo app before sending again.`);
  }
});

async function handle(ev: any, reply: (text: string) => Response): Promise<Response> {
  if (ev.type === "ADDED_TO_SPACE") return json({ text: `Quo Send is here. ${HELP}` });
  if (ev.type !== "MESSAGE" && ev.type !== "APP_COMMAND") return json({});

  const msg = ev.message || {};
  const isSend = String(msg.slashCommand?.commandId ?? ev.appCommandMetadata?.appCommandId ?? "") === "1";
  console.log("[quo-gchat-send] event", ev.type, isSend ? "send" : "other", msg.thread?.name ? "in thread" : "no thread");
  if (!isSend) return reply(HELP);

  const text = String(msg.argumentText ?? "").trim();
  const files = (msg.attachment || []).length;
  const noFiles = files ? ` The ${files === 1 ? "photo or file was" : `${files} photos or files were`} not sent: SMS from Chat is words only, send it from the Quo app.` : "";
  if (!text) return reply(`Nothing to send.${noFiles} ${HELP}`);
  if (text.length > 1600) return reply(`That is ${text.length} characters; Quo allows 1,600. Nothing was sent.`);

  // Which person this thread is with, and from which line.
  const thread = String(msg.thread?.name || "");
  const link = thread ? await readLink(thread) : null;
  if (!link) {
    return reply("This thread isn't linked to a phone number yet, so nothing was sent. Use /send inside a thread Quo started; older threads link the next time that person sends an SMS or calls.");
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
  const isGroup = (link.group || []).length > 1;
  if (isGroup && !GROUP_SEND_TESTERS.includes(email)) {
    return reply("Replying to a group from Chat is still being tested. Reply from the Quo app for now. Nothing was sent.");
  }
  const sender = (pn.users || []).find((u: any) => email && String(u.email || "").toLowerCase() === email);
  if (!sender) {
    console.log("[quo-gchat-send] not allowed on line", `…${link.line.slice(-4)}`, email ? "email given" : "no email on event");
    return reply(`Only people Quo allows on ${pretty(link.line)} can send from it. Nothing was sent.`);
  }

  const sr = await quo("/messages", {
    method: "POST",
    body: JSON.stringify({ content: text, from: pn.id, to: (isGroup ? link.group! : [link.other]).map((d) => `+1${d}`), userId: sender.id }),
  });
  if (!sr.ok) {
    const err = (await sr.text()).slice(0, 200);
    console.error("[quo-gchat-send] quo send failed", sr.status, err);
    return reply(`Quo refused it (${sr.status}). Nothing was sent.`);
  }
  const sentId = (await sr.json().catch(() => null))?.data?.id;
  // Tell the relay which group this was, so its 📤 copy lands in the group thread.
  if (sentId && isGroup) await saveSent(sentId, link);
  if (sentId) EdgeRuntime.waitUntil(watchDelivery(sentId, link, quo));
  console.log("[quo-gchat-send] sent", `…${link.line.slice(-4)} → …${link.other.slice(-4)}`);
  const to = isGroup ? "the group" : pretty(link.other);
  return reply(`✓ Sent to ${to}.${noFiles}`);
}

// Through supabase-js: Storage refuses the injected secret key as a bare
// Bearer token ("Invalid Compact JWS").
type Link = { line: string; other: string; group?: string[]; key?: string };
async function readLink(thread: string): Promise<Link | null> {
  const url = Deno.env.get("SUPABASE_URL"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return null;
  const { data, error } = await createClient(url, svc).storage.from(BUCKET).download(threadObject(thread));
  if (error || !data) {
    if (error && !/not found/i.test(error.message)) console.error("[quo-gchat-send] link read failed", error.message.slice(0, 200));
    return null;
  }
  const j = await data.text().then((t) => JSON.parse(t)).catch(() => null);
  const line = digits10(j?.line), other = digits10(j?.other);
  const group = Array.isArray(j?.group) ? j.group.map(digits10).filter((d: string) => d.length === 10) : [];
  const key = typeof j?.key === "string" ? j.key : "";
  return line.length === 10 && other.length === 10 ? { line, other, group, key } : null;
}

async function saveSent(id: string, link: Link) {
  const url = Deno.env.get("SUPABASE_URL"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return;
  const { error } = await createClient(url, svc).storage.from(BUCKET).upload(`sent/${id.replace(/[^A-Za-z0-9_-]/g, "")}.json`,
    new Blob([JSON.stringify({ group: link.group, key: link.key })], { type: "application/json" }), { upsert: true, contentType: "application/json" });
  if (error) console.error("[quo-gchat-send] sent record not saved", error.message.slice(0, 200));
}

// spaces/AAA/threads/BBB → threads/AAA__BBB.json (same rule as quo-gchat).
function threadObject(thread: string) {
  const m = thread.match(/^spaces\/([^/]+)\/threads\/([^/]+)$/);
  return m ? `threads/${m[1]}__${m[2]}.json` : `threads/${thread.replace(/[^A-Za-z0-9_-]/g, "_")}.json`;
}

// Look the sent message up at about 20s, 1 min and 2 min (the edge function
// stops at 150s). Delivered: done, the mirror posts the 📤 line. Undelivered
// or failed: warn in the person's thread. Still queued or sent after that:
// say nothing, some carriers never report back.
async function watchDelivery(id: string, link: Link, quo: (p: string) => Promise<Response>) {
  try {
    for (const wait of [20_000, 40_000, 60_000]) {
      await new Promise((r) => setTimeout(r, wait));
      const r = await quo(`/messages/${encodeURIComponent(id)}`);
      if (!r.ok) continue;
      const m = (await r.json().catch(() => null))?.data || {};
      const status = String(m.status || "");
      if (status === "delivered") return;
      if (status !== "undelivered" && status !== "failed") continue;
      const hook = Deno.env.get(LINES[link.line] || "");
      if (!hook) return console.error("[quo-gchat-send] undelivered, no space webhook for", `…${link.line.slice(-4)}`);
      const said = String(m.text || "").replace(/\s+/g, " ").slice(0, 120);
      const url = new URL(hook);
      url.searchParams.set("threadKey", link.key || `sms-${link.other}`);
      url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
      const pr = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ text: `⚠️ SMS NOT delivered to ${(link.group || []).length > 1 ? "the group" : dashed(link.other)}${said ? `\n"${said}"` : ""}\nCheck the number, or reach them from the Quo app.` }),
      });
      if (!pr.ok) console.error("[quo-gchat-send] undelivered warning not posted", pr.status);
      console.log("[quo-gchat-send] undelivered", `…${link.other.slice(-4)}`, status);
      return;
    }
  } catch (e) {
    console.error("[quo-gchat-send] delivery check error", String(e));
  }
}

const dashed = (d: string) => (d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : d);
