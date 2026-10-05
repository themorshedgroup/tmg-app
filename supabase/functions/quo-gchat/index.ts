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
//   message.received / message.delivered → 📱Name | 512-555-0100, then the text; photos show in the
//                                          thread (copied to storage, see showMedia)
//   call.completed                       → one line: in/out, missed, length
//   call.summary.completed               → Quo's AI summary + next steps
//   call.voicemail.completed             → the full voicemail transcript
//   call.transcript.completed            → only when it is a voicemail (nobody
//                                          on our side spoke); regular call
//                                          transcripts are not mirrored
// Both voicemail paths share requestId vm-<callId>, so one voicemail posts once.
//
// Groups: a group text gets its own thread (threadKey grp-<hash of members>),
// headed "👥 first names" (or a named group like "Team TⓂ️G"). /send there replies to the whole group.
// Threads: threadKey = the other party's 10-digit number, so every text and
// call with the same person lands in the same thread. requestId = Quo's id, so
// a Quo retry of the same event never posts twice.
//
// Names: the person's name comes from the contacts saved in Quo (needs secret
// QUO_GCHAT_API_KEY), read once every 10 minutes; unknown numbers show as the
// number. No *bold* markers: phone notifications print them as raw asterisks.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TOKEN_SHA256 = "d00c4d11eb0dd4ce20295cdc7c66f2a19d20ca4bbe8395e4c2a75673aea77a3f";

// Quo line → secret of the Chat space it posts to. Shared lines are flagged
// so outgoing texts read "Sent" instead of "You".
const LINES: Record<string, { secret: string; shared?: boolean; who?: string }> = {
  "5126436688": { secret: "GCHAT_TEXTS_WEBHOOK", who: "Symon" },        // Symon → "TMG SMS"
  "5126101095": { secret: "GCHAT_WEBHOOK_MAINLINE", shared: true },     // main line → "TMG Main Line"
  "5128314911": { secret: "GCHAT_WEBHOOK_ALEXANDRA", who: "Alexa" },    // → "Quo - Alexandra"
  "5129803161": { secret: "GCHAT_WEBHOOK_CAMILA", who: "Camila" },      // → "Quo - Camila"
  "5126101096": { secret: "GCHAT_WEBHOOK_ANGELICA", who: "Angelica" },  // → "Quo - Angelica"
  "5129001113": { secret: "GCHAT_WEBHOOK_GUSTAVO", who: "Gustavo" },    // → "Quo - Gustavo"
};

// Group headers list first names in this order (seniority, Symon's call
// 2026-10-06), then everyone else A to Z, then bare numbers. The agents' own
// cells are not in the repo (it is public): secret QUO_TEAM_NUMBERS holds
// {"<10 digits>": "<first name>"}.
const TEAM = ["Tarek", "Brad", "Brett", "Kyle", "Symon", "Angelica", "Alexa", "Gustavo", "Camila"];
const OPS = ["Symon", "Angelica", "Alexa", "Gustavo", "Camila"];
// Groups with a name of their own: exactly these people, nobody else.
const NAMED_GROUPS: [string, string[]][] = [
  ["Team TⓂ️G", TEAM],
  ["TⓂ️G Ops w/ Tarek", [...OPS, "Tarek"]],
  ["TⓂ️G Ops", OPS],
];

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
    // A group text: everyone on it except our line, sender first. Empty for 1:1.
    let group: string[] = [];
    if (evt === "message.received" || evt === "message.delivered") {
      outbound = evt === "message.delivered";
      // The webhook can list only part of a group (seen 2026-10-06: a text to
      // two numbers arrived as a 1:1), so read Quo's own record of the message.
      const full = await quoMessage(m.id);
      const fromN = digits10(full?.from || m.from || ctx.senderIdentifier);
      const tos = [...new Set([...(Array.isArray(m.to) ? m.to : [m.to]), ...(ctx.recipientIdentifiers || []), ...(full?.to || [])]
        .map(digits10).filter((d) => d.length === 10))];
      if (full?.phoneNumberId && !m.phoneNumberId) m.phoneNumberId = full.phoneNumberId;
      console.log("[quo-gchat] message", evt, `from …${fromN.slice(-4)}`, `to ${tos.map((d) => "…" + d.slice(-4)).join(",")}`,
        `hook to ${(Array.isArray(m.to) ? m.to : [m.to]).length}`, full ? "quo ok" : "quo n/a");
      if (outbound) ourLine = fromN;
      else {
        // A group text lists every member in `to`, not always our line first.
        // With two of our lines on it, Quo sends one event per line: the
        // event's phoneNumberId says which one this is.
        const ours = tos.filter((d) => LINES[d]);
        ourLine = (ours.length > 1 ? await lineForId(m.phoneNumberId) : "") || ours[0] || tos[0] || "";
      }
      const members = [...new Set([outbound ? "" : fromN, ...tos].filter((d) => d && d !== ourLine))];
      other = members[0] || "";
      if (members.length > 1) group = members;
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

    // Build the message for this event. A group gets its own thread, named
    // after its members, so it never lands in one member's private thread.
    const who = await nameFor(other);
    const groupHead = group.length ? `${await groupLabel(group, ourLine)}\n` : "";
    const threadKey = group.length ? `grp-${(await sha256([...group].sort().join(","))).slice(0, 20)}` : `sms-${other}`;
    let text = "", requestId = "";
    let cardsV2: any[] | undefined;
    if (evt.startsWith("message.")) {
      let body = String(m.body ?? m.text ?? m.content ?? "").trim();
      const media = Array.isArray(m.media) ? m.media : [];
      if (media.length) {
        const shown = await showMedia(media, String(m.id || crypto.randomUUID()), who);
        cardsV2 = shown.card ? [shown.card] : undefined;
        body = `${body}${body ? "\n" : ""}${shown.note}`;
      }
      if (!body) body = "[empty message]";
      const head = group.length
        ? `${groupHead}${outbound ? `📤 ${line.shared ? "Sent" : "You"}` : `📱${who}`}`
        : outbound ? `📤 ${line.shared ? "Sent" : "You"} → ${who}` : `📱${who}`;
      text = `${head}\n${body}`;
      if (m.id) requestId = `quo-${m.id}`;
    } else if (evt === "call.completed") {
      const status = String(m.status || "").toLowerCase();
      const missed = /miss|no-answer|unanswered|abandon|busy|fail|cancel/.test(status) || (!outbound && !m.answeredAt && !Number(m.duration));
      const label = missed
        ? (outbound ? "📞 Unanswered call to" : "📞 Missed call from")
        : (outbound ? `📞 Call to` : `📞 Call from`);
      text = `${label} ${who}${missed ? "" : `, ${mins(m.duration)}`}`;
      if (m.id) requestId = `call-${m.id}`;
    } else if (evt === "call.summary.completed") {
      const summary = (Array.isArray(m.summary) ? m.summary : [m.summary]).filter(Boolean).map((s: unknown) => `• ${s}`);
      const steps = (Array.isArray(m.nextSteps) ? m.nextSteps : [m.nextSteps]).filter(Boolean).map((s: unknown) => `• ${s}`);
      if (!summary.length && !steps.length) return ok({ ignored: "empty summary" });
      text = `📝 Call summary, ${who}`;
      if (summary.length) text += `\n${summary.join("\n")}`;
      if (steps.length) text += `\nNext steps\n${steps.join("\n")}`;
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
      text = `🎙️ Voicemail from ${who}${m.duration ? `, ${mins(m.duration)}` : ""}\n${transcript || "[no transcript yet, open Quo to listen]"}`;
      const callId = m.callId || m.id;
      if (callId) requestId = `vm-${callId}`;
    } else {
      return ok({ ignored: evt });
    }
    if (deepLink && !evt.startsWith("message.")) text += `\n<${deepLink}|Open in Quo>`;

    const url = new URL(hook);
    url.searchParams.set("threadKey", threadKey);
    url.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");
    if (requestId) url.searchParams.set("requestId", requestId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60));

    const post = () => fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(cardsV2 ? { text, cardsV2 } : { text }),
    });
    let r = await post();
    // Some spaces' webhooks refuse requestId ("Request Id is not supported for
    // webhooks"). Post again without it rather than lose the message.
    if (r.status === 400 && url.searchParams.has("requestId")) {
      const err = await r.text();
      if (!/request ?id/i.test(err) && !cardsV2) {
        console.error("[quo-gchat] chat post failed", r.status, err.slice(0, 300));
        return ok({ posted: false, evt });
      }
      if (/request ?id/i.test(err)) url.searchParams.delete("requestId");
      r = await post();
    }
    // A photo card Chat will not take must not cost the text: post it plain.
    if (r.status === 400 && cardsV2) {
      console.error("[quo-gchat] photo card refused", (await r.text()).slice(0, 200));
      cardsV2 = undefined;
      text = text.replace(/\[[^\]\n]*below[^\]\n]*\]$/, `[photos/files, open Quo to view]`);
      r = await post();
    }
    // The space id goes back in the reply so Quo's events log shows where each post landed.
    let space = "";
    if (!r.ok) console.error("[quo-gchat] chat post failed", r.status, (await r.text()).slice(0, 300));
    else {
      const posted = await r.json().catch(() => null);
      space = String(posted?.space?.name || posted?.name || "").split("/")[1] || `${url.host}${url.pathname.slice(0, 40)}`;
      await saveLink(posted, ourLine, other, group, threadKey);
    }
    return ok({ posted: r.ok, evt, space });
  } catch (e) {
    console.error("[quo-gchat] error", String(e));
    return ok({ error: "handled" });
  }
});

// "Tarek Morshed | 512-799-8001" when the number is a saved Quo contact, else
// just the number. Contacts are cached for 10 minutes per running copy; if
// Quo is slow or down the message still posts, with the number only.
let contacts: { at: number; map: Map<string, string> } | null = null;
async function nameFor(d: string) {
  const num = d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : pretty(d);
  try {
    if (!contacts || Date.now() - contacts.at > 10 * 60_000) {
      const key = Deno.env.get("QUO_GCHAT_API_KEY");
      if (!key) return num;
      const map = new Map<string, string>();
      let pageToken = "";
      for (let page = 0; page < 40; page++) {
        const u = new URL("https://api.openphone.com/v1/contacts");
        u.searchParams.set("maxResults", "50");
        if (pageToken) u.searchParams.set("pageToken", pageToken);
        const r = await fetch(u, { headers: { Authorization: key }, signal: AbortSignal.timeout(4000) });
        if (!r.ok) throw new Error(`contacts ${r.status}`);
        const j = await r.json();
        for (const c of j.data || []) {
          const f = c.defaultFields || {};
          const name = [f.firstName, f.lastName].filter(Boolean).join(" ").trim() || String(f.company || "").trim();
          if (!name) continue;
          for (const p of f.phoneNumbers || []) {
            const k = digits10(p?.value);
            if (k.length === 10 && !map.has(k)) map.set(k, name);
          }
        }
        pageToken = j.nextPageToken || "";
        if (!pageToken) break;
      }
      contacts = { at: Date.now(), map };
    }
    const name = contacts.map.get(d) || teamName(d);
    return name ? `${name} | ${num}` : num;
  } catch (e) {
    console.error("[quo-gchat] contact names unavailable", String(e).slice(0, 120));
    contacts = { at: Date.now() - 9 * 60_000, map: contacts?.map || new Map() }; // retry in a minute
    const name = contacts.map.get(d) || teamName(d);
    return name ? `${name} | ${num}` : num;
  }
}

// Remember which line and person each Chat thread belongs to, so /send
// (quo-gchat-send) knows who to text. One small JSON file per thread in the
// private "quo-gchat" bucket, rewritten on every post. Never blocks posting.
// Goes through supabase-js: the injected key is a new-style secret key, not a
// JWT, and Storage refused it as a bare Bearer token ("Invalid Compact JWS"),
// so links were not saved and /send said "not linked" in every new thread.
const BUCKET = "quo-gchat";
async function saveLink(posted: any, line: string, other: string, group: string[], key: string) {
  try {
    const m = String(posted?.thread?.name || "").match(/^spaces\/([^/]+)\/threads\/([^/]+)$/);
    const url = Deno.env.get("SUPABASE_URL"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!m || !url || !svc) return;
    const files = createClient(url, svc).storage;
    const put = () => files.from(BUCKET).upload(`threads/${m[1]}__${m[2]}.json`,
      new Blob([JSON.stringify(group.length ? { line, other, group, key } : { line, other, key })], { type: "application/json" }),
      { upsert: true, contentType: "application/json" });
    let { error } = await put();
    if (error && /not found/i.test(error.message)) {
      await files.createBucket(BUCKET, { public: false });
      ({ error } = await put());
    }
    if (error) console.error("[quo-gchat] thread link not saved", error.message.slice(0, 200));
  } catch (e) {
    console.error("[quo-gchat] thread link error", String(e));
  }
}

// Photos and files on a message. Quo's own links may be private or expire,
// so each one is copied into the private "quo-gchat" bucket and shown through
// a one-year signed link: photos as images in the thread, other files as an
// "Open" button. Anything that fails to copy falls back to "open Quo to view".
async function showMedia(media: any[], msgId: string, who: string): Promise<{ note: string; card?: any }> {
  const n = media.length;
  const fallback = `[${n} photo${n > 1 ? "s" : ""}/file${n > 1 ? "s" : ""}, open Quo to view]`;
  const url = Deno.env.get("SUPABASE_URL"), svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !svc) return { note: fallback };
  const files = createClient(url, svc).storage;
  const widgets: any[] = [];
  let photos = 0, others = 0, failed = 0;
  for (const [i, item] of media.slice(0, 10).entries()) {
    try {
      const src = String(item?.url || "");
      if (!/^https:\/\//.test(src)) { failed++; continue; }
      let r = await fetch(src, { signal: AbortSignal.timeout(8000) });
      const key = Deno.env.get("QUO_GCHAT_API_KEY");
      if ((r.status === 401 || r.status === 403) && key) r = await fetch(src, { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { failed++; continue; }
      const type = String(item?.type || r.headers.get("content-type") || "application/octet-stream").split(";")[0];
      const blob = await r.blob();
      if (blob.size > 20 * 1024 * 1024) { failed++; continue; }
      const ext = (type.split("/")[1] || "bin").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "bin";
      const path = `media/${msgId.replace(/[^A-Za-z0-9_-]/g, "")}-${i}.${ext}`;
      const put = () => files.from(BUCKET).upload(path, blob, { upsert: true, contentType: type });
      let up = await put();
      if (up.error && /not found/i.test(up.error.message)) { await files.createBucket(BUCKET, { public: false }); up = await put(); }
      if (up.error) { failed++; continue; }
      const { data } = await files.from(BUCKET).createSignedUrl(path, 365 * 86400);
      if (!data?.signedUrl) { failed++; continue; }
      if (type.startsWith("image/")) {
        photos++;
        widgets.push({ image: { imageUrl: data.signedUrl, altText: `Photo from ${who}`, onClick: { openLink: { url: data.signedUrl } } } });
      } else {
        others++;
        widgets.push({ buttonList: { buttons: [{ text: `Open ${type.split("/")[1] || "file"}`, onClick: { openLink: { url: data.signedUrl } } }] } });
      }
    } catch (e) {
      console.error("[quo-gchat] media copy failed", String(e).slice(0, 120));
      failed++;
    }
  }
  failed += Math.max(0, n - 10);
  const parts = [];
  if (photos) parts.push(`📷 ${photos} photo${photos > 1 ? "s" : ""} below`);
  if (others) parts.push(`📎 ${others} file${others > 1 ? "s" : ""} below`);
  if (failed) parts.push(`${failed} more, open Quo to view`);
  const note = `[${parts.join(", ")}]`;
  return widgets.length ? { note, card: { cardId: "media", card: { sections: [{ widgets }] } } } : { note: fallback };
}

// "Team TⓂ️G" for a named group, else "👥 Tarek, Brad, and Jane".
// Our line's owner counts as a member but is not listed (it is their space).
let teamCells: Record<string, string> | null = null;
function teamName(d: string) {
  if (LINES[d]?.who) return LINES[d].who!;
  if (!teamCells) {
    try { teamCells = JSON.parse(Deno.env.get("QUO_TEAM_NUMBERS") || "{}"); } catch (_) { teamCells = {}; }
  }
  return teamCells![d] || "";
}
async function groupLabel(members: string[], ourLine: string) {
  const everyone = [...members, ...(LINES[ourLine]?.shared ? [] : [ourLine])].map(teamName);
  if (everyone.every(Boolean)) {
    const set = [...new Set(everyone)].sort().join();
    for (const [label, names] of NAMED_GROUPS) if ([...names].sort().join() === set) return label;
  }
  const listed = await Promise.all(members.map(async (d) => {
    const team = teamName(d);
    if (team) return { name: team, rank: TEAM.indexOf(team) };
    const full = await nameFor(d);
    const named = full.includes(" | ");
    return { name: named ? full.split(" ")[0] : full, rank: named ? 100 : 200 };
  }));
  listed.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  const n = listed.map((x) => x.name);
  const joined = n.length < 3 ? n.join(" and ") : `${n.slice(0, -1).join(", ")}, and ${n.at(-1)}`;
  return `👥 ${joined}`;
}

// Quo's own record of a message ({from, to[], phoneNumberId}); null if Quo
// can't be reached, so the webhook payload is used as before.
async function quoMessage(id: unknown) {
  const key = Deno.env.get("QUO_GCHAT_API_KEY");
  if (!id || !key) return null;
  try {
    const r = await fetch(`https://api.openphone.com/v1/messages/${encodeURIComponent(String(id))}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`message ${r.status}`);
    const d = (await r.json()).data || {};
    return { from: d.from, to: Array.isArray(d.to) ? d.to : [d.to].filter(Boolean), phoneNumberId: d.phoneNumberId };
  } catch (e) {
    console.error("[quo-gchat] message lookup failed", String(e).slice(0, 120));
    return null;
  }
}

// Quo phone-number id → its 10 digits, for group texts that include two of
// our lines. Cached 10 minutes; "" if Quo can't be reached.
let lineIds: { at: number; map: Map<string, string> } | null = null;
async function lineForId(id: unknown) {
  if (!id) return "";
  try {
    if (!lineIds || Date.now() - lineIds.at > 10 * 60_000) {
      const key = Deno.env.get("QUO_GCHAT_API_KEY");
      if (!key) return "";
      const r = await fetch("https://api.openphone.com/v1/phone-numbers", { headers: { Authorization: key }, signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`phone-numbers ${r.status}`);
      const map = new Map<string, string>();
      for (const p of (await r.json()).data || []) map.set(String(p.id), digits10(p.number));
      lineIds = { at: Date.now(), map };
    }
    return lineIds.map.get(String(id)) || "";
  } catch (e) {
    console.error("[quo-gchat] phone numbers unavailable", String(e).slice(0, 120));
    return "";
  }
}
