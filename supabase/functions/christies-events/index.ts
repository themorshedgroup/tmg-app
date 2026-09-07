// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: christies-events
// Crawls Tarek's mail for Christie's International Real Estate events and puts
// the FUTURE ones on the shared TMG Team Calendar as "Christie's - <Event>".
//
// Two shapes of mail produce events, and they are handled very differently:
//   invite   — a real Google Calendar invitation (e.g. "Toolbox Thursday").
//              Its text/calendar part carries exact SUMMARY / DTSTART / DTEND /
//              RRULE, so this path is pure parsing. No AI, no guessing.
//   roundup  — a prose email listing several upcoming Christie's events. There
//              is nothing structured to read, so Claude extracts the list.
// Symon chose auto-create for BOTH (2026-09-05): nothing waits for approval.
// Every created event is therefore logged in christies_events with its Team
// Calendar id, so a bad batch is findable and removable without hunting the
// calendar by eye.
//
// Deploy: `supabase functions deploy christies-events --no-verify-jwt`
//   "Verify JWT" must be OFF because `sync` is cron-invoked with a shared
//   secret and no user session (same shape as ctc-emails). Every OTHER action
//   still verifies a real Supabase session itself, below.
//
// Secrets:
//   CHRISTIES_CRON_SECRET  = long random string; only this function and its
//                            pg_cron job know it. Its own secret on purpose —
//                            rotating it must never touch CTC_EMAILS_CRON_SECRET.
//   GOOGLE_CLIENT_SECRET   = same OAuth client as google-calendar
//   GCAL_SA_CLIENT_EMAIL   } the Team Calendar service account, exactly as
//   GCAL_SA_PRIVATE_KEY    } time-off OOO events already use
//   GCAL_SA_SUBJECT        } (optional; domain-wide delegation subject)
//   ANTHROPIC_API_KEY      = same key as ai-chat / tasks-ai (roundups only)
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// ── Auth model ───────────────────────────────────────────────────────────
// READING mail uses the per-user Google refresh token in google_tokens — the
// token Tarek personally granted, with the gmail.readonly scope supabase.js
// already requests. He revokes app access in his own Google account and this
// stops immediately, on his authority. WRITING to the Team Calendar uses the
// service account, because the write must not depend on whose session (or
// cron tick) triggered the run.
//
// ── Privacy ──────────────────────────────────────────────────────────────
// No message body is persisted. A roundup body is fetched live into a local
// variable, sent on one Claude call, and dropped. christies_events stores event
// data plus the Gmail ids needed to dedupe and link back — never a body.
//
// POST actions:
//   { action: 'sync', lookback_days? }   → cron (Bearer <CHRISTIES_CRON_SECRET>) or an admin session
//   { action: 'preview', lookback_days? } → same gate; reads the mail and returns the
//             events it WOULD create, writing nothing to Google, nothing to the
//             ledger, and not consuming the AI-read record. Safe to run before
//             letting anything touch the shared Team Calendar.
//   { action: 'list', limit? }           → active session; what the crawler has created
//   { action: 'list_sources' }           → active session; crawled mailboxes + state
//   { action: 'set_source', user_id, enabled, query_extra? } → ADMIN session only
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Same model as the other AI surfaces (ctc-emails, tasks-ai) — one place to swap.
const MODEL = "claude-sonnet-5";

// Public OAuth client id, copied verbatim from google-calendar/index.ts.
const GOOGLE_CLIENT_ID = "931478099859-9jifv0fl9v3s67oc7pa5ka6j61eeujfq.apps.googleusercontent.com";

// The shared company Team Calendar. MUST stay identical to TEAM_CALENDAR_ID in
// google-calendar/index.ts — that function renders this calendar in the app.
const TEAM_CALENDAR_ID = "c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com";

// TMG runs on Central time. Used only when a source gives a wall-clock time with
// no zone attached (common in prose roundups); real invites carry their own TZID.
const DEFAULT_TZ = "America/Chicago";

// ── Crawl tuning ─────────────────────────────────────────────────────────
const PAGE_SIZE = 50;
const MAX_PAGES = 4;                 // ≤200 messages per mailbox per run
const DEFAULT_LOOKBACK_DAYS = 30;    // how far back to look for mail (NOT for events)
const MESSAGE_CONCURRENCY = 6;
const MAX_BODY_CHARS = 6000;
const ROUNDUP_CONF_FLOOR = 0.45;     // below this a prose-extracted event is logged, not created

// Received mail only; archived mail still included (no `in:inbox`).
const BASE_QUERY = "-in:chats -in:drafts -in:spam -in:trash";
// Gmail-side net. Deliberately wide — the real filter is CHRISTIES_RE below,
// applied to the subject+body of every message this returns.
// Two AND-ed groups, because either one alone is wrong. The Austin Christie's
// office sends from christiesrealestatels.com — but so does every Supra showing
// alert, CDA, and daily listings digest, and a 60-day preview on the domain
// alone returned 200 messages of which none were events. So: it must be
// Christie's AND it must look like an invitation to something.
const CHRISTIES_DOMAIN = "christiesrealestatels.com";
const CHRISTIES_GROUP =
  '(from:' + CHRISTIES_DOMAIN + ' OR "' + CHRISTIES_DOMAIN + '"' +
  ' OR "Toolbox Thursday" OR "Christie\'s" OR Christies)';
const EVENT_GROUP =
  '("Toolbox Thursday" OR "Marketing Monday" OR "upcoming events" OR "save the date"' +
  ' OR RSVP OR eventbrite OR invited OR "register here" OR workshop OR "happy hour"' +
  ' OR clubhouse OR carpool OR "CE class" OR webinar OR seminar OR luncheon OR mixer)';
// Known high-volume transactional noise from the same domain. Excluded at the
// Gmail layer so these never even cost a metadata fetch.
const NOISE_QUERY =
  '-subject:"New Listings for" -subject:"Daily Briefing" -subject:"Birthday is Upcoming"' +
  ' -"Supra Showings" -subject:"Order Complete" -subject:"Order Received" -subject:"CDA"';
const MATCH_QUERY = CHRISTIES_GROUP + " " + EVENT_GROUP + " " + NOISE_QUERY;
// Code-side gate. Gmail search is fuzzy (it stems and ignores punctuation), so a
// message it returns still has to actually say one of these things.
const CHRISTIES_RE = /christie[’']?s|toolbox\s+thursday|\bCIRE\b|christiesrealestatels\.com/i;
// Second net, in code, guarding the one expensive step. Gmail's operators are
// fuzzy (it stems words and ignores punctuation), so a message it returns still
// has to read like an event announcement before a single token is spent on it.
const EVENT_HINT_RE =
  /toolbox\s+thursday|marketing\s+monday|upcoming\s+events?|save\s+the\s+date|you'?re\s+invited|\brsvp\b|register\s+(?:here|now)|eventbrite|happy\s+hour|clubhouse|carpool|workshop|luncheon|\bmixer\b|\bwebinar\b|\bseminar\b|CE\s+class/i;
// Transactional mail that shares the sender domain. Belt and braces with
// NOISE_QUERY above: Gmail's negative terms are best-effort, this is exact.
const NOISE_RE =
  /supra\s+showing|keybox|\bCDA\b|disbursement|new\s+listings\s+for|daily\s+briefing|birthday\s+is\s+upcoming|signotter|order\s+(?:received|complete)|wiring\s+instructions|\binvoice\b/i;

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

// ── Caller auth ──────────────────────────────────────────────────────────
// Verbatim gate from ctc-emails/index.ts: an active TMG profile, plus access[]
// roles so set_source can require an admin. `access` is a Postgres text[].
async function authorizeCaller(req: Request) {
  const sb = serviceClient();
  if (!sb) return { ok: false as const, status: 500, error: "Server auth not configured." };

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false as const, status: 401, error: "Sign in required." };

  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return { ok: false as const, status: 401, error: "Invalid or expired session." };

  const { data: profile, error: pErr } = await sb
    .from("profiles").select("status, access, email").eq("id", user.id).single();
  if (pErr || !profile) return { ok: false as const, status: 403, error: "Account pending approval." };
  if (profile.status !== "active") return { ok: false as const, status: 403, error: "Account is not active." };

  const roles: string[] = Array.isArray(profile.access) ? profile.access : (profile.access ? [profile.access] : []);
  const isAdmin = roles.some((r) => r === "admin" || r === "operations");
  return { ok: true as const, userId: user.id, email: profile.email || null, roles, isAdmin, sb };
}

// ── Google: user refresh token → access token (verbatim from google-calendar) ──
async function googleAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to refresh Google token");
  }
  return data.access_token;
}

// Mint an access token for an ARBITRARY user id — the "no user present" path a
// cron run needs. Throws `needs_connect` when the token is missing or revoked.
async function userAccessToken(sb: any, userId: string): Promise<string> {
  const { data: row, error } = await sb
    .from("google_tokens").select("refresh_token").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("google_tokens read failed: " + error.message);
  if (!row?.refresh_token) throw new Error("needs_connect");
  try {
    return await googleAccessToken(row.refresh_token);
  } catch (e) {
    throw new Error("needs_connect: " + String((e as any)?.message || e));
  }
}

// ── Service-account token for the Team Calendar ──────────────────────────
// Copied verbatim from google-calendar/index.ts (same secrets, same scope, same
// optional domain-wide-delegation subject). Duplicated rather than imported
// because edge functions deploy as independent bundles; if that function's
// version changes, change this one in the same commit.
function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    "pkcs8", der.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"],
  );
}
let _saCache: { token: string; exp: number } | null = null;
async function serviceAccountToken(): Promise<string> {
  const email = Deno.env.get("GCAL_SA_CLIENT_EMAIL");
  let key = Deno.env.get("GCAL_SA_PRIVATE_KEY") || "";
  if (!email || !key) throw new Error("team_calendar_not_configured");
  key = key.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  if (_saCache && _saCache.exp > now + 60) return _saCache.token;

  const header = { alg: "RS256", typ: "JWT" };
  const claim: Record<string, unknown> = {
    iss: email,
    scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const subject = Deno.env.get("GCAL_SA_SUBJECT");
  if (subject) claim.sub = subject;
  const te = new TextEncoder();
  const unsigned = b64url(te.encode(JSON.stringify(header))) + "." + b64url(te.encode(JSON.stringify(claim)));
  const pk = await importPkcs8(key);
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pk, te.encode(unsigned));
  const jwt = unsigned + "." + b64url(new Uint8Array(sig));

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }).toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Service-account token failed");
  }
  _saCache = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) };
  return data.access_token;
}

// ── Gmail helpers ────────────────────────────────────────────────────────
function b64urlDecode(s: string): string {
  const b64 = (s || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
function gmailHeader(headers: any[], name: string): string {
  const h = (headers || []).find((x: any) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || "";
}
function gmailBodyText(payload: any): string {
  if (!payload) return "";
  const mime = payload.mimeType || "";
  if (mime === "text/plain" && payload.body?.data) return b64urlDecode(payload.body.data);
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) {
      const t = gmailBodyText(p);
      if (t) return t;
    }
  }
  if (mime === "text/html" && payload.body?.data) {
    return b64urlDecode(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}
// Gmail permalink pinned to the mailbox owner: thread ids are per-mailbox, so a
// bare /u/0/ link opens the wrong account for anyone else signed into Chrome.
function gmailPermalink(owner: string, threadId: string): string {
  return "https://mail.google.com/mail/?authuser=" + encodeURIComponent(owner) + "#all/" + threadId;
}

// Find the calendar invitation inside a message. Gmail exposes it either inline
// (text/calendar with body.data) or as an invite.ics attachment (body.attachmentId,
// which needs a second fetch). Both are handled; neither is assumed.
async function extractIcs(token: string, messageId: string, payload: any): Promise<string | null> {
  const stack: any[] = [payload];
  while (stack.length) {
    const p = stack.pop();
    if (!p) continue;
    const mime = String(p.mimeType || "").toLowerCase();
    const name = String(p.filename || "").toLowerCase();
    const isCal = mime.startsWith("text/calendar") || mime === "application/ics" || name.endsWith(".ics");
    if (isCal) {
      if (p.body?.data) return b64urlDecode(p.body.data);
      if (p.body?.attachmentId) {
        const url = "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
          encodeURIComponent(messageId) + "/attachments/" + encodeURIComponent(p.body.attachmentId);
        const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d?.data) return b64urlDecode(d.data);
      }
    }
    if (Array.isArray(p.parts)) for (const c of p.parts) stack.push(c);
  }
  return null;
}

// Gmail's per-user rate limit without going fully serial (verbatim from ctc-emails).
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Time zones ───────────────────────────────────────────────────────────
// An ICS DTSTART with a TZID is a WALL CLOCK time in that zone, not an instant.
// Turning it into one needs the zone's offset ON THAT DATE (DST moves it), which
// is why this goes through Intl rather than a fixed offset: "10am Central" in
// March and in December are different UTC instants, and a fixed offset silently
// puts half the year's events on the calendar an hour off.
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUTC - utcMs;
}
function zonedToUtcMs(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  try {
    // Two passes: the first offset is looked up at the wrong instant when the
    // date sits within an hour of a DST switch; re-applying it converges.
    let guess = naive - tzOffsetMs(naive, tz);
    guess = naive - tzOffsetMs(guess, tz);
    return guess;
  } catch (_) {
    return naive; // unknown zone → treat as UTC rather than dropping the event
  }
}

// ── ICS parsing ──────────────────────────────────────────────────────────
type IcsTime = { allDay: boolean; date?: string; local?: string; tz?: string; utcMs: number };

function unfoldIcs(raw: string): string[] {
  // RFC 5545 folds long lines by starting the continuation with a space or tab.
  return raw.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}
function icsParam(line: string, name: string): string | null {
  const m = line.match(new RegExp("[;:]" + name + "=([^;:]+)", "i"));
  return m ? m[1] : null;
}
function icsValue(line: string): string {
  const i = line.indexOf(":");
  return i < 0 ? "" : line
    .slice(i + 1)
    .replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\")
    .trim();
}
function parseIcsTime(line: string): IcsTime | null {
  const v = icsValue(line);
  const tz = icsParam(line, "TZID") || undefined;
  const dateOnly = /VALUE=DATE(?![-T])/i.test(line) || /^\d{8}$/.test(v);
  if (dateOnly) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return {
      allDay: true,
      date: m[1] + "-" + m[2] + "-" + m[3],
      utcMs: Date.UTC(+m[1], +m[2] - 1, +m[3]),
    };
  }
  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/);
  if (!m) return null;
  const [_, y, mo, d, h, mi, s, z] = m;
  const local = y + "-" + mo + "-" + d + "T" + h + ":" + mi + ":" + s;
  if (z === "Z") return { allDay: false, local: local + "Z", utcMs: Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) };
  const zone = tz || DEFAULT_TZ;
  return { allDay: false, local, tz: zone, utcMs: zonedToUtcMs(+y, +mo, +d, +h, +mi, +s, zone) };
}

type ParsedEvent = {
  uid: string | null;
  sequence: number | null;
  summary: string;
  // The invite's own body text. Toolbox Thursday's weekly topic usually lives
  // here (or after a colon in SUMMARY) rather than in the series title, so it is
  // parsed, stored, and written onto the calendar event.
  description: string | null;
  location: string | null;
  start: IcsTime;
  end: IcsTime | null;
  rrule: string | null;
  // Set on the prose path, where the model reports the week's subject as its own
  // field instead of jamming it into the title.
  topic?: string | null;
  // Set when the invite targets ONE occurrence of a recurring series (Google
  // sends these when a single week is changed). It is the original start time of
  // the occurrence being overridden — the anchor used to patch that week alone
  // instead of renaming every Thursday.
  recurrenceId: IcsTime | null;
  cancelled: boolean;
};

function parseIcsEvents(raw: string): ParsedEvent[] {
  const lines = unfoldIcs(raw);
  const method = (lines.find((l) => /^METHOD:/i.test(l)) || "").toUpperCase();
  const methodCancel = /METHOD:CANCEL/i.test(method);
  const out: ParsedEvent[] = [];
  let cur: Partial<ParsedEvent> | null = null;

  for (const line of lines) {
    if (/^BEGIN:VEVENT/i.test(line)) { cur = { cancelled: methodCancel }; continue; }
    if (/^END:VEVENT/i.test(line)) {
      if (cur?.start && cur?.summary) {
        out.push({
          uid: cur.uid || null,
          sequence: cur.sequence ?? null,
          summary: cur.summary,
          description: cur.description || null,
          location: cur.location || null,
          start: cur.start as IcsTime,
          end: (cur.end as IcsTime) || null,
          rrule: cur.rrule || null,
          recurrenceId: (cur.recurrenceId as IcsTime) || null,
          cancelled: !!cur.cancelled,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    if (/^UID[;:]/i.test(line)) cur.uid = icsValue(line) || null;
    else if (/^SEQUENCE[;:]/i.test(line)) cur.sequence = Number(icsValue(line)) || 0;
    else if (/^SUMMARY[;:]/i.test(line)) cur.summary = icsValue(line);
    else if (/^DESCRIPTION[;:]/i.test(line)) cur.description = icsValue(line) || null;
    else if (/^RECURRENCE-ID[;:]/i.test(line)) cur.recurrenceId = parseIcsTime(line) || undefined;
    else if (/^LOCATION[;:]/i.test(line)) cur.location = icsValue(line) || null;
    else if (/^DTSTART[;:]/i.test(line)) cur.start = parseIcsTime(line) || undefined;
    else if (/^DTEND[;:]/i.test(line)) cur.end = parseIcsTime(line) || undefined;
    else if (/^RRULE[;:]/i.test(line)) cur.rrule = "RRULE:" + icsValue(line);
    else if (/^STATUS[;:]/i.test(line) && /CANCELLED/i.test(icsValue(line))) cur.cancelled = true;
  }
  return out;
}

// ── Recurring series that started in the past ────────────────────────────
// "Toolbox Thursday" is a weekly invite whose DTSTART may be months old. Symon
// asked for future events only, so the series start is walked forward to the
// next occurrence instead of dropping the event (which would lose the series) or
// importing it as-is (which would paint months of past Thursdays onto the shared
// calendar). COUNT is the one case left alone: moving DTSTART would silently
// change how many occurrences the rule produces.
function rollForward(start: IcsTime, end: IcsTime | null, rrule: string | null, nowMs: number):
  { start: IcsTime; end: IcsTime | null; dead: boolean } {
  if (start.utcMs >= nowMs) return { start, end, dead: false };
  if (!rrule) return { start, end, dead: true };

  const freq = (rrule.match(/FREQ=([A-Z]+)/i) || [])[1]?.toUpperCase() || "";
  const interval = Math.max(1, Number((rrule.match(/INTERVAL=(\d+)/i) || [])[1] || 1));
  const untilRaw = (rrule.match(/UNTIL=([0-9TZ]+)/i) || [])[1];
  if (untilRaw) {
    const m = untilRaw.match(/^(\d{4})(\d{2})(\d{2})/);
    if (m && Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59) < nowMs) return { start, end, dead: true };
  }
  if (/COUNT=/i.test(rrule)) return { start, end, dead: false }; // leave the rule intact
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(freq)) return { start, end, dead: false };

  const stepDays = freq === "DAILY" ? interval : freq === "WEEKLY" ? 7 * interval : 0;
  const d = new Date(start.utcMs);
  let guard = 0;
  while (d.getTime() < nowMs && guard++ < 600) {
    if (stepDays) d.setUTCDate(d.getUTCDate() + stepDays);
    else if (freq === "MONTHLY") d.setUTCMonth(d.getUTCMonth() + interval);
    else d.setUTCFullYear(d.getUTCFullYear() + interval);
  }
  const shiftMs = d.getTime() - start.utcMs;
  const shiftTime = (t: IcsTime, extraMs: number): IcsTime => {
    const nd = new Date(t.utcMs + extraMs);
    if (t.allDay) {
      return { ...t, utcMs: nd.getTime(), date: nd.toISOString().slice(0, 10) };
    }
    if (t.tz) {
      // Keep the same wall-clock time in the same zone: rebuild the local string
      // from the shifted DATE, then re-resolve the offset for that new date.
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: t.tz, hour12: false,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(nd);
      const g = (k: string) => parts.find((p) => p.type === k)?.value || "00";
      const local = g("year") + "-" + g("month") + "-" + g("day") + "T" +
        (g("hour") === "24" ? "00" : g("hour")) + ":" + g("minute") + ":" + g("second");
      return {
        allDay: false, tz: t.tz, local,
        utcMs: zonedToUtcMs(+g("year"), +g("month"), +g("day"), +g("hour") % 24, +g("minute"), +g("second"), t.tz),
      };
    }
    return { ...t, utcMs: nd.getTime(), local: nd.toISOString().replace(/\.\d+Z$/, "Z") };
  };
  const ns = shiftTime(start, shiftMs);
  const ne = end ? shiftTime(end, shiftMs) : null; // same shift on both ends preserves the duration
  return { start: ns, end: ne, dead: false };
}

// ── Titles ───────────────────────────────────────────────────────────────
// Every event lands as "Christie's - <Event Name>", so the source's own
// Christie's branding is stripped first — otherwise the calendar fills with
// "Christie's - Christie's International Real Estate Toolbox Thursday".
function cleanTitle(raw: string): string {
  let t = String(raw || "").trim();
  t = t.replace(/^(?:(?:invitation|updated invitation|invite|canceled(?: event)?|cancelled(?: event)?|accepted|declined|fwd|fw|re)\s*:\s*)+/i, "");
  t = t.replace(/\s*@\s*\w{3},?\s+\w{3}\s+\d{1,2},?\s+\d{4}.*$/i, ""); // Google's " @ Thu Sep 11, 2026 10am" tail
  t = t.replace(/\((?:[^()]*@[^()]*)\)\s*$/, "");                       // trailing "(owner@example.com)"
  t = t.replace(/^christie[’']?s\s+international\s+real\s+estate\s*[-–—:|]*\s*/i, "");
  t = t.replace(/^christie[’']?s\s*[-–—:|]+\s*/i, "");
  t = t.replace(/^christie[’']?s\s+/i, "");
  t = t.replace(/^\s*[-–—:|]+\s*/, "").replace(/\s+/g, " ").trim();
  return (t || "Event").slice(0, 180);
}

// A weekly series carries its week's subject in the title after a separator
// ("Toolbox Thursday: Working With Relocation Buyers") or in the invite body.
// Split it out so the base name can be matched against the recurring series
// while the topic still shows on the event.
function splitTopic(cleaned: string): { base: string; topic: string | null } {
  const m = cleaned.match(/^([^:]{3,}?)\s*:\s*(\S.*)$/) ||
            cleaned.match(/^(.{3,}?)\s+[-–—]\s+(\S.*)$/);
  if (!m) return { base: cleaned, topic: null };
  return { base: m[1].trim(), topic: m[2].trim().slice(0, 160) };
}

// Fallback when the title is just "Toolbox Thursday": look for an explicitly
// labelled topic in the invite body. Deliberately narrow — the first line of a
// description is as often a Zoom link or a greeting as it is the subject, and a
// wrong topic in the event name is worse than none.
function topicFromDescription(description: string | null): string | null {
  if (!description) return null;
  const m = description.match(/^[ \t]*(?:topic|subject|this week|featuring|session)[ \t]*[:\-–—][ \t]*(\S.*)$/im);
  if (!m) return null;
  return m[1].trim().replace(/\s+/g, " ").slice(0, 160) || null;
}

// "Christie's - Toolbox Thursday: <topic>". Capped so the calendar's month view
// stays readable rather than showing one event and an ellipsis.
function calendarTitle(raw: string, topic?: string | null): string {
  const cleaned = cleanTitle(raw);
  const split = splitTopic(cleaned);
  const t = (topic || split.topic || "").trim();
  if (!t) return ("Christie's - " + split.base).slice(0, 220);
  // When the "topic" is just the event's own name again — the prose model tends
  // to answer both fields with the same phrase, differing only by a year — one
  // of them is redundant. Keep the fuller wording, drop the repetition, rather
  // than shipping "Masters Circle & Agents Summit: 2026 Masters Circle &
  // Agents Summit".
  const nt = normKey(t), nb = normKey(split.base);
  if (nt.includes(nb) || nb.includes(nt)) {
    return ("Christie's - " + (t.length >= split.base.length ? t : split.base)).slice(0, 220);
  }
  return ("Christie's - " + split.base + ": " + t).slice(0, 220);
}
// The series name with any week-specific topic removed — what an announcement
// email's event has to match to be recognised as "that same Toolbox Thursday".
function baseTitle(raw: string): string {
  return splitTopic(cleanTitle(raw)).base;
}
function normKey(s: string): string {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// ── Team Calendar writes ─────────────────────────────────────────────────
function googleTimes(ev: { start: IcsTime; end: IcsTime | null }) {
  const s = ev.start;
  const e = ev.end;
  if (s.allDay) {
    const endDate = e?.date || new Date(s.utcMs + 86400000).toISOString().slice(0, 10);
    return { start: { date: s.date }, end: { date: endDate } };
  }
  const mk = (t: IcsTime) => t.tz
    ? { dateTime: t.local, timeZone: t.tz }
    : { dateTime: t.local || new Date(t.utcMs).toISOString().replace(/\.\d+Z$/, "Z") };
  const endT: IcsTime = e || { allDay: false, tz: s.tz, local: undefined, utcMs: s.utcMs + 3600000 };
  if (!e) {
    // No DTEND: default to one hour, expressed the same way the start was.
    if (s.tz) {
      const d = new Date(s.utcMs + 3600000);
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: s.tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }).formatToParts(d);
      const g = (k: string) => parts.find((p) => p.type === k)?.value || "00";
      endT.local = g("year") + "-" + g("month") + "-" + g("day") + "T" +
        (g("hour") === "24" ? "00" : g("hour")) + ":" + g("minute") + ":" + g("second");
    }
  }
  return { start: mk(s), end: mk(endT) };
}

async function teamFetch(path: string, init: RequestInit) {
  const token = await serviceAccountToken();
  const url = "https://www.googleapis.com/calendar/v3/calendars/" +
    encodeURIComponent(TEAM_CALENDAR_ID) + path;
  const res = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: "Bearer " + token, "Content-Type": "application/json" },
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || ("Team Calendar HTTP " + res.status));
  return data;
}

// Patch ONE occurrence of a recurring series. This is what makes a per-week
// topic possible: "Toolbox Thursday" is a single weekly invite with a single
// title, so writing this week's subject into the series would rename every
// Thursday, past and future. Google exposes each occurrence as its own event id
// under /instances, and patching that id changes only that week.
async function patchInstance(seriesEventId: string, occurrenceUtcMs: number, body: Record<string, unknown>) {
  const timeMin = new Date(occurrenceUtcMs - 18 * 3600000).toISOString();
  const timeMax = new Date(occurrenceUtcMs + 18 * 3600000).toISOString();
  const list: any = await teamFetch(
    "/events/" + encodeURIComponent(seriesEventId) + "/instances" +
    "?timeMin=" + encodeURIComponent(timeMin) + "&timeMax=" + encodeURIComponent(timeMax) + "&maxResults=10",
    { method: "GET" });
  const items: any[] = list?.items || [];
  if (!items.length) return null;
  // Nearest occurrence inside the window — an instance can be moved a few hours
  // from its nominal slot, so exact-equality matching would miss it.
  let best: any = null, bestGap = Infinity;
  for (const it of items) {
    const startStr = it?.start?.dateTime || it?.start?.date;
    if (!startStr) continue;
    const gap = Math.abs(new Date(startStr).getTime() - occurrenceUtcMs);
    if (gap < bestGap) { best = it; bestGap = gap; }
  }
  if (!best?.id) return null;
  await teamFetch("/events/" + encodeURIComponent(best.id), { method: "PATCH", body: JSON.stringify(body) });
  return best.id as string;
}

// What goes in the event's description box. The topic leads, the invite's own
// body follows, and the provenance block is last so it never pushes the useful
// part out of the calendar popup's first few lines.
function eventDescription(
  ctx: { sourceEmail: string; subject: string; gmailThreadId: string },
  ev: ParsedEvent, topic: string | null, origin: "invite" | "roundup",
): string {
  return [
    topic ? "Topic: " + topic : "",
    ev.description ? ev.description.trim().slice(0, 1500) : "",
    "—",
    "Added automatically by TMG App from " + ctx.sourceEmail + "'s mail.",
    "Source email: " + ctx.subject,
    ctx.gmailThreadId ? gmailPermalink(ctx.sourceEmail, ctx.gmailThreadId) : "",
    origin === "roundup" ? "(Read from an announcement email by AI — check it against the original.)" : "",
  ].filter(Boolean).join("\n");
}

// ── Claude: read a prose roundup ─────────────────────────────────────────
const EXTRACT_SYSTEM = [
  "You extract calendar events from a real-estate brokerage's email.",
  "Return ONLY Christie's International Real Estate events (Christie's, CIRE, or a Christie's-run series such as Toolbox Thursday).",
  "Ignore anything that is not a dated event: newsletters, listings, market stats, congratulations, general marketing.",
  "Return bare JSON, no prose and no code fence, shaped exactly:",
  '{"events":[{"title":"","topic":"","start":"YYYY-MM-DDTHH:MM:SS","end":"YYYY-MM-DDTHH:MM:SS","all_day":false,"location":"","confidence":0.0}]}',
  "Rules:",
  "- title is the RECURRING SERIES or event name only (e.g. \"Toolbox Thursday\"), never including that week's subject.",
  "- topic is that week's subject or session title (e.g. \"Working With Relocation Buyers\"). Omit it if the email does not state one — do NOT summarise the email into a topic.",
  "- start/end are LOCAL wall-clock times, no timezone suffix. If the email states a timezone, convert to " + DEFAULT_TZ + ".",
  "- If only a date is given with no time, set all_day true and use T00:00:00.",
  "- If no end time is given, omit end.",
  "- If the year is missing, infer it from the email's date; never emit a date in the past.",
  "- Leave \"Christie's\" off both fields — that prefix is added later.",
  "- confidence 0-1: how sure you are this is a real, dated, Christie's event. Guessed times lower it.",
  "- If there are no such events, return {\"events\":[]}. Never invent one.",
].join("\n");

async function askClaude(apiKey: string, prompt: string, maxTokens = 900) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL, max_tokens: maxTokens, system: EXTRACT_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || "Claude API error");
  return (data?.content || []).filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n").trim();
}
function parseJsonObject(text: string): any | null {
  const t = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}
// The model returns wall-clock strings; turn them into the same IcsTime shape
// the ICS path produces so everything downstream is identical.
function timeFromLocalString(s: string, allDay: boolean): IcsTime | null {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const [_, y, mo, d, h, mi, sec] = m;
  if (allDay || h === undefined) {
    return { allDay: true, date: y + "-" + mo + "-" + d, utcMs: Date.UTC(+y, +mo - 1, +d) };
  }
  const local = y + "-" + mo + "-" + d + "T" + h + ":" + mi + ":" + (sec || "00");
  return { allDay: false, local, tz: DEFAULT_TZ, utcMs: zonedToUtcMs(+y, +mo, +d, +h, +mi, +Number(sec || 0), DEFAULT_TZ) };
}

// ═════════════════════════════════════════════════════════════════════════
// One event → the Team Calendar + the ledger.
// This is the only place that writes to Google, so every skip reason and every
// created/updated/cancelled event is recorded in exactly one shape.
// ═════════════════════════════════════════════════════════════════════════
async function pushEvent(sb: any, ctx: {
  sourceUserId: string; sourceEmail: string;
  gmailMessageId: string; gmailThreadId: string; rfcMessageId: string | null;
  subject: string; emailDate: string | null;
}, ev: ParsedEvent, origin: "invite" | "roundup", confidence: number | null, nowMs: number,
   dryRun = false) {

  // Topic, in order of trust: what the model reported (prose only) > what the
  // title itself carries after a colon > an explicitly labelled line in the
  // invite body. Never guessed from free text.
  const cleaned = cleanTitle(ev.summary);
  const split = splitTopic(cleaned);
  const topic = (ev.topic || split.topic || topicFromDescription(ev.description) || null);
  const seriesBase = split.base;
  const calTitle = calendarTitle(ev.summary, topic);
  const occurrenceDay = new Date(ev.start.utcMs).toISOString().slice(0, 10);

  // Dedup keys, in three shapes:
  //   an override of one week  → uid + that occurrence's date
  //   a normal invite          → the ICS UID (stable across resends/recipients)
  //   prose                    → series name + the day it lands on
  const dedupKey = ev.uid
    ? (ev.recurrenceId ? "uid:" + ev.uid + "#" + occurrenceDay : "uid:" + ev.uid)
    : "txt:" + normKey(seriesBase) + "|" + occurrenceDay;

  const { data: existing } = await sb
    .from("christies_events").select("*").eq("dedup_key", dedupKey).maybeSingle();

  const description = eventDescription(ctx, ev, topic, origin);

  const base: Record<string, unknown> = {
    source_user_id: ctx.sourceUserId,
    source_email: ctx.sourceEmail,
    dedup_key: dedupKey,
    ics_uid: ev.uid,
    ics_sequence: ev.sequence,
    ics_recurrence_id: ev.recurrenceId ? new Date(ev.recurrenceId.utcMs).toISOString() : null,
    gmail_message_id: ctx.gmailMessageId,
    gmail_thread_id: ctx.gmailThreadId,
    rfc_message_id: ctx.rfcMessageId,
    email_subject: ctx.subject.slice(0, 500),
    email_date: ctx.emailDate,
    origin,
    confidence,
    source_title: String(ev.summary || "").slice(0, 500),
    base_title: seriesBase.slice(0, 300),
    topic: topic ? topic.slice(0, 300) : null,
    calendar_title: calTitle,
    starts_at: new Date(ev.start.utcMs).toISOString(),
    ends_at: ev.end ? new Date(ev.end.utcMs).toISOString() : null,
    all_day: ev.start.allDay,
    time_zone: ev.start.tz || null,
    recurrence: ev.rrule,
    location: ev.location ? String(ev.location).slice(0, 500) : null,
    updated_at: new Date().toISOString(),
  };
  const save = async (patch: Record<string, unknown>) => {
    if (dryRun) return;
    const row = { ...base, ...patch };
    const { error } = existing
      ? await sb.from("christies_events").update(row).eq("id", existing.id)
      : await sb.from("christies_events").insert(row);
    if (error) throw new Error("ledger write failed: " + error.message);
  };

  // ── Cancellation. A CANCEL for something we never created is not an error —
  // it just means the crawl started after the event was dropped.
  if (ev.cancelled) {
    if (ev.start.utcMs < nowMs && !existing?.team_event_id) {
      if (dryRun) return { action: "skipped_past_cancel", title: calTitle, starts_at: base.starts_at };
      return { action: "skipped_past_cancel", title: calTitle };
    }
    if (dryRun) return { action: "would_cancel", title: calTitle, topic, starts_at: base.starts_at };
    if (existing?.team_event_id) {
      try {
        await teamFetch("/events/" + encodeURIComponent(existing.team_event_id), { method: "DELETE" });
      } catch (e) {
        const msg = String((e as any)?.message || e);
        if (!/410|404|deleted|not found/i.test(msg)) {
          await save({ status: "error", last_error: msg.slice(0, 500) });
          return { action: "error", error: msg };
        }
      }
    }
    await save({ status: "cancelled", team_event_id: null, last_error: null });
    return { action: "cancelled", title: calTitle };
  }

  // ── Future only.
  if (ev.start.utcMs < nowMs) {
    if (!existing) await save({ status: "skipped_past", team_event_id: null });
    return { action: "skipped_past", title: calTitle };
  }

  // ── Prose below the floor is recorded, not published. Auto-create is on, but
  // "the model was mostly guessing" is not an event.
  if (origin === "roundup" && confidence !== null && confidence < ROUNDUP_CONF_FLOOR) {
    if (!existing) await save({ status: "skipped_low_confidence", team_event_id: null });
    return { action: "skipped_low_confidence", title: calTitle, confidence };
  }

  const times = googleTimes(ev);
  const body: Record<string, unknown> = {
    summary: calTitle,
    location: ev.location || undefined,
    description,
    ...times,
    extendedProperties: { private: { tmg_christies: dedupKey, tmg_source: "christies-events" } },
  };
  if (ev.rrule && !ev.recurrenceId) body.recurrence = [ev.rrule];

  // ── The per-week topic path ────────────────────────────────────────────
  // Toolbox Thursday is ONE weekly invite whose title never changes; each week's
  // subject arrives either as a single-occurrence invite update or in an
  // announcement email. Both are written onto that week's occurrence only, so
  // the series keeps its name and the calendar shows the topic where it belongs.
  // Anything that finds no live series falls through and is created normally.
  let seriesRow: any = null;
  if (ev.recurrenceId && ev.uid) {
    const { data: rows } = await sb
      .from("christies_events").select("id,team_event_id,recurrence")
      .eq("ics_uid", ev.uid).is("ics_recurrence_id", null)
      .not("team_event_id", "is", null).limit(1);
    seriesRow = (rows || [])[0] || null;
  } else if (origin === "roundup" && topic) {
    const { data: rows } = await sb
      .from("christies_events").select("id,team_event_id,recurrence,base_title")
      .not("recurrence", "is", null).not("team_event_id", "is", null)
      .ilike("base_title", seriesBase).limit(5);
    seriesRow = (rows || []).find((r: any) => normKey(r.base_title) === normKey(seriesBase)) || null;
  }

  if (dryRun) {
    return {
      action: seriesRow?.team_event_id
        ? "would_update_this_week_only"
        : (existing?.team_event_id ? "would_update" : "would_create"),
      title: calTitle, topic, origin, confidence,
      starts_at: base.starts_at, ends_at: base.ends_at,
      all_day: ev.start.allDay, time_zone: ev.start.tz || null,
      repeats: ev.rrule ? ev.rrule.replace(/^RRULE:/, "") : null,
      location: ev.location || null,
      source_subject: ctx.subject,
    };
  }

  if (seriesRow?.team_event_id) {
    try {
      const instanceId = await patchInstance(seriesRow.team_event_id, ev.start.utcMs, {
        summary: calTitle, description,
        ...(ev.location ? { location: ev.location } : {}),
      });
      if (instanceId) {
        await save({ status: "instance_updated", team_event_id: instanceId, last_error: null });
        return { action: "instance_updated", title: calTitle, topic };
      }
      // No occurrence on that date — the announcement is about something that is
      // not on the series after all, so create it as its own event below.
    } catch (e) {
      const msg = String((e as any)?.message || e);
      await save({ status: "error", last_error: ("instance patch: " + msg).slice(0, 500) });
      return { action: "error", title: calTitle, error: msg };
    }
  }

  // ── The cross-shape duplicate guard. The same event often arrives BOTH as an
  // invite and as a line in an announcement; those have different dedup_keys by
  // construction, so without this the calendar gets two of everything.
  if (!existing) {
    const dayStart = new Date(ev.start.utcMs); dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart.getTime() + 86400000);
    const { data: twins } = await sb
      .from("christies_events")
      .select("id,dedup_key,team_event_id,base_title")
      .not("team_event_id", "is", null)
      .gte("starts_at", dayStart.toISOString())
      .lt("starts_at", dayEnd.toISOString());
    // Containment, not equality: two emails describe the same day's event with
    // different fullness ("2026 Masters Circle & Agents Summit" vs "Agents
    // Summit"), and exact matching would put both on the calendar. Same day plus
    // one name inside the other is a duplicate, not a coincidence.
    const nb = normKey(seriesBase);
    const twin = (twins || []).find((t: any) => {
      if (t.dedup_key === dedupKey) return false;
      const tb = normKey(t.base_title || "");
      if (!tb || !nb) return false;
      return tb === nb || tb.includes(nb) || nb.includes(tb);
    });
    if (twin) {
      await save({ status: "skipped_duplicate", team_event_id: null });
      return { action: "skipped_duplicate", title: calTitle };
    }
  }

  try {
    if (existing?.team_event_id) {
      const changed =
        existing.calendar_title !== calTitle ||
        existing.starts_at !== base.starts_at ||
        existing.ends_at !== base.ends_at ||
        existing.location !== base.location ||
        existing.recurrence !== base.recurrence ||
        existing.topic !== base.topic ||
        (ev.sequence ?? 0) > (existing.ics_sequence ?? 0);
      if (!changed) {
        await save({ status: existing.status, team_event_id: existing.team_event_id, last_error: null });
        return { action: "unchanged", title: calTitle };
      }
      await teamFetch("/events/" + encodeURIComponent(existing.team_event_id), {
        method: "PATCH", body: JSON.stringify(body),
      });
      await save({ status: "updated", team_event_id: existing.team_event_id, last_error: null });
      return { action: "updated", title: calTitle };
    }
    const created: any = await teamFetch("/events", { method: "POST", body: JSON.stringify(body) });
    await save({ status: "created", team_event_id: created?.id || null, last_error: null });
    return { action: "created", title: calTitle, topic, event_id: created?.id || null };
  } catch (e) {
    const msg = String((e as any)?.message || e);
    await save({ status: "error", last_error: msg.slice(0, 500) });
    return { action: "error", title: calTitle, error: msg };
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Crawl one mailbox.
// ═════════════════════════════════════════════════════════════════════════
async function syncSource(sb: any, src: any, opts: { lookbackDays: number; anthropicKey: string | null; dryRun?: boolean }) {
  const stat: Record<string, unknown> = {
    mailbox: src.email, user_id: src.user_id,
    messages: 0, invites: 0, roundups: 0,
    created: 0, updated: 0, cancelled: 0, skipped: 0, errors: 0,
  };

  // Gate 1: the owner's profile must still be active — someone who has left the
  // company stops being crawled even if nobody flipped `enabled` off.
  const { data: prof, error: pErr } = await sb
    .from("profiles").select("status").eq("id", src.user_id).maybeSingle();
  if (pErr) throw new Error("profile read failed: " + pErr.message);
  if (!prof || prof.status !== "active") {
    await sb.from("christies_sources")
      .update({ last_synced_at: new Date().toISOString(), last_error: "owner_not_active" })
      .eq("user_id", src.user_id);
    return { ...stat, skipped_reason: "owner_not_active" };
  }

  // Gate 2: the owner must personally still have a live google_tokens row.
  const token = await userAccessToken(sb, src.user_id); // throws needs_connect

  // Gmail permalinks are pinned to the Google account via ?authuser=, so the
  // stored address has to be the one Gmail itself reports, not the TMG profile
  // spelling. Same correction ctc-emails makes.
  try {
    const pr = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: "Bearer " + token },
    });
    const pd = await pr.json().catch(() => ({}));
    const real = (pd?.emailAddress || "").toLowerCase();
    if (real && real !== String(src.email || "").toLowerCase()) {
      await sb.from("christies_sources")
        .update({ email: real, updated_at: new Date().toISOString() }).eq("user_id", src.user_id);
      src = { ...src, email: real };
      stat.mailbox = real;
    }
  } catch (_) { /* non-fatal: keep the stored address for this run */ }

  const nowMs = Date.now();
  const afterS = Math.floor(nowMs / 1000) - opts.lookbackDays * 86400;
  const q = [BASE_QUERY, MATCH_QUERY, (src.query_extra || "").trim(), "after:" + afterS]
    .filter(Boolean).join(" ");

  // ── Collect message ids (a re-scan every run; dedup makes overlap free, so
  // there is no cursor to corrupt and a missed run costs nothing) ──
  const ids: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    url.searchParams.set("maxResults", String(PAGE_SIZE));
    url.searchParams.set("q", q);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d?.error?.message || ("Gmail list failed (HTTP " + r.status + ")"));
    for (const m of d.messages || []) if (m?.id) ids.push(m.id);
    pageToken = d.nextPageToken || null;
    if (!pageToken) break;
  }
  stat.messages = ids.length;

  const msgs = await mapLimit(ids, MESSAGE_CONCURRENCY, async (id) => {
    const r = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(id) + "?format=full",
      { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  });

  const results: any[] = [];
  let claudeCalls = 0;
  // A per-run cost ceiling. 30 lets a first run drain a whole backlog in one
  // pass — after that christies_ai_reads means each email is read once ever, so
  // steady-state runs use a fraction of this.
  const MAX_CLAUDE_CALLS = 30;

  for (const m of msgs) {
    if (!m) continue;
    const headers = m.payload?.headers || [];
    const subject = gmailHeader(headers, "Subject") || "(no subject)";
    const rfcId = gmailHeader(headers, "Message-ID") || null;
    const dateHdr = gmailHeader(headers, "Date");
    const emailDate = Number(m.internalDate)
      ? new Date(Number(m.internalDate)).toISOString()
      : (dateHdr ? new Date(dateHdr).toISOString() : null);

    const fromHdr = gmailHeader(headers, "From");

    const ctx = {
      sourceUserId: src.user_id, sourceEmail: src.email,
      gmailMessageId: m.id, gmailThreadId: m.threadId, rfcMessageId: rfcId,
      subject, emailDate,
    };

    const ics = await extractIcs(token, m.id, m.payload);

    if (ics) {
      // ── Invite path: exact, no AI. The Christie's test runs against the
      // event's own SUMMARY as well as the subject, because a forwarded invite
      // can carry a neutral subject line.
      const parsed = parseIcsEvents(ics);
      for (const ev of parsed) {
        const hay = fromHdr + " " + subject + " " + ev.summary + " " + (ev.location || "");
        if (!CHRISTIES_RE.test(hay)) continue;
        stat.invites = (stat.invites as number) + 1;
        const rolled = rollForward(ev.start, ev.end, ev.rrule, nowMs);
        if (rolled.dead && !ev.cancelled) {
          results.push({ action: "skipped_past", title: calendarTitle(ev.summary) });
          stat.skipped = (stat.skipped as number) + 1;
          continue;
        }
        const res = await pushEvent(sb, ctx, { ...ev, start: rolled.start, end: rolled.end }, "invite", null, nowMs, !!opts.dryRun);
        results.push(res);
      }
      continue;
    }

    // ── Roundup path: prose. Body is fetched live, read once, and dropped.
    const body = gmailBodyText(m.payload) || m.snippet || "";
    const hay = fromHdr + " " + subject + " " + body;
    if (!CHRISTIES_RE.test(hay)) continue;
    if (NOISE_RE.test(subject) || !EVENT_HINT_RE.test(hay)) continue;

    // Each email is read by the model EXACTLY ONCE, ever. The crawl re-scans a
    // rolling 30-day window every run, so without this ledger the same handful of
    // announcement emails would be re-sent to Claude every hour — same answer,
    // billed again each time (~24x the necessary spend, for nothing). One row per
    // Gmail message id makes AI cost a function of how much mail arrives, not how
    // often the cron ticks. The invite path never reaches here: it costs nothing.
    if (!opts.dryRun) {
      const { data: alreadyRead } = await sb
        .from("christies_ai_reads").select("gmail_message_id")
        .eq("gmail_message_id", m.id).maybeSingle();
      if (alreadyRead) continue;
    }

    if (!opts.anthropicKey) { results.push({ action: "skipped_no_ai", subject }); continue; }
    if (claudeCalls >= MAX_CLAUDE_CALLS) { results.push({ action: "skipped_ai_budget", subject }); continue; }
    claudeCalls++;
    stat.roundups = (stat.roundups as number) + 1;

    let extracted: any = null;
    try {
      const prompt = [
        "TODAY: " + new Date(nowMs).toISOString().slice(0, 10) + " (" + DEFAULT_TZ + ")",
        "EMAIL DATE: " + (emailDate || "unknown"),
        "FROM: " + fromHdr,
        "SUBJECT: " + subject,
        "",
        "BODY (fetched live, not stored):",
        body.slice(0, MAX_BODY_CHARS),
      ].join("\n");
      extracted = parseJsonObject(await askClaude(opts.anthropicKey, prompt));
      // Recorded only on a SUCCESSFUL call, and before the events are pushed: a
      // rate-limited or timed-out call must be retried next run, but an email the
      // model has answered on — even with "no events here" — must never be paid
      // for twice.
      if (!opts.dryRun) await sb.from("christies_ai_reads").insert({
        gmail_message_id: m.id,
        source_user_id: src.user_id,
        email_subject: subject.slice(0, 500),
        events_found: (extracted?.events || []).length,
      });
    } catch (e) {
      results.push({ action: "error", subject, error: String((e as any)?.message || e) });
      continue;
    }

    for (const raw of (extracted?.events || [])) {
      const allDay = !!raw?.all_day;
      const start = timeFromLocalString(raw?.start, allDay);
      if (!start || !raw?.title) continue;
      const end = raw?.end ? timeFromLocalString(raw.end, allDay) : null;
      const ev: ParsedEvent = {
        uid: null, sequence: null,
        summary: String(raw.title),
        description: null,
        topic: raw?.topic ? String(raw.topic).trim().slice(0, 160) || null : null,
        location: raw?.location ? String(raw.location) : null,
        start, end, rrule: null, recurrenceId: null, cancelled: false,
      };
      const conf = Number(raw?.confidence);
      results.push(await pushEvent(sb, ctx, ev, "roundup", Number.isFinite(conf) ? conf : 0.5, nowMs, !!opts.dryRun));
    }
  }

  for (const r of results) {
    if (r.action === "created") stat.created = (stat.created as number) + 1;
    else if (r.action === "updated" || r.action === "instance_updated") stat.updated = (stat.updated as number) + 1;
    else if (r.action === "cancelled") stat.cancelled = (stat.cancelled as number) + 1;
    else if (r.action === "error") stat.errors = (stat.errors as number) + 1;
    else if (String(r.action || "").startsWith("skipped")) stat.skipped = (stat.skipped as number) + 1;
  }

  if (!opts.dryRun) {
    await sb.from("christies_sources")
      .update({ last_synced_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() })
      .eq("user_id", src.user_id);
  }

  return { ...stat, events: results };
}

// ═════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    if (!action) return json({ error: "Missing action." }, 400);

    // ── sync: cron shared secret, OR an admin session ("Sync now") ──
    // `preview` is `sync` with every write disabled: it reads the mail, works out
    // exactly which events it would put on the Team Calendar, and returns that
    // list. Nothing is written to Google, nothing to the ledger, and the AI-read
    // record is deliberately NOT consumed — so the real sync afterwards behaves
    // as though the preview never ran. Same gate as sync.
    if (action === "sync" || action === "preview") {
      const dryRun = action === "preview";
      const secret = Deno.env.get("CHRISTIES_CRON_SECRET") || "";
      const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      let sb: any = null;
      let via = "cron";

      if (secret && bearer && bearer === secret) {
        sb = serviceClient();
      } else {
        const auth = await authorizeCaller(req);
        if (!auth.ok) return json({ error: "unauthorized" }, 401);
        if (!auth.isAdmin) return json({ error: "Admin access required to run a sync." }, 403);
        sb = auth.sb; via = "admin:" + auth.userId;
      }
      if (!sb) return json({ error: "server not configured" }, 500);

      const lookbackDays = Math.min(Math.max(Number(body.lookback_days) || DEFAULT_LOOKBACK_DAYS, 1), 180);
      const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") || null;

      const { data: sources, error: sErr } = await sb
        .from("christies_sources")
        .select("user_id,email,enabled,query_extra")
        .eq("enabled", true);
      if (sErr) return json({ error: "source read failed: " + sErr.message }, 500);
      if (!sources?.length) {
        return json({ ok: true, via, sources: [], note: "No enabled mailbox. Enable one with set_source." }, 200);
      }

      const out: any[] = [];
      for (const src of sources) {
        // One mailbox failing must never abort the others.
        try {
          out.push(await syncSource(sb, src, { lookbackDays, anthropicKey, dryRun }));
        } catch (e) {
          const msg = String((e as any)?.message || e);
          try {
            await sb.from("christies_sources")
              .update({ last_synced_at: new Date().toISOString(), last_error: msg.slice(0, 500) })
              .eq("user_id", src.user_id);
          } catch (_) { /* reporting the error must not itself abort the run */ }
          out.push({ mailbox: src.email, user_id: src.user_id, error: msg });
        }
      }

      if (dryRun) {
        // Flat, sorted, human-readable: this is the list a person reads before
        // agreeing to let anything touch the shared calendar.
        const planned = out.flatMap((r: any) => (r.events || []))
          .filter((e: any) => String(e.action || "").startsWith("would_"))
          .sort((a: any, b: any) => String(a.starts_at).localeCompare(String(b.starts_at)));
        const skipped = out.flatMap((r: any) => (r.events || []))
          .filter((e: any) => !String(e.action || "").startsWith("would_"));
        return json({
          ok: true, via, dry_run: true,
          note: "Nothing was written. This is what a real sync would put on the Team Calendar.",
          planned, planned_count: planned.length,
          skipped, skipped_count: skipped.length,
          mailboxes: out.map((r: any) => ({
            mailbox: r.mailbox, messages: r.messages, invites: r.invites,
            roundups: r.roundups, error: r.error,
          })),
        }, 200);
      }

      return json({
        ok: true, via, sources: out,
        totals: {
          created: out.reduce((n, r) => n + (Number(r.created) || 0), 0),
          updated: out.reduce((n, r) => n + (Number(r.updated) || 0), 0),
          cancelled: out.reduce((n, r) => n + (Number(r.cancelled) || 0), 0),
          skipped: out.reduce((n, r) => n + (Number(r.skipped) || 0), 0),
          errors: out.reduce((n, r) => n + (Number(r.errors) || 0), 0) + out.filter((r) => r.error).length,
        },
      }, 200);
    }

    // ── Every remaining action needs a real, active TMG session ──
    const auth = await authorizeCaller(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    const sb = auth.sb;

    if (action === "list") {
      const limit = Math.min(Math.max(Number(body.limit) || 50, 1), 200);
      const { data, error } = await sb
        .from("christies_events")
        .select("id,calendar_title,base_title,topic,source_title,starts_at,ends_at,all_day,location,origin,confidence,status,team_event_id,email_subject,email_date,source_email,last_error")
        .order("starts_at", { ascending: true })
        .limit(limit);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, events: data || [] }, 200);
    }

    if (action === "list_sources") {
      if (!auth.isAdmin) return json({ error: "Admin access required." }, 403);
      const { data, error } = await sb
        .from("christies_sources")
        .select("user_id,email,enabled,query_extra,last_synced_at,last_error");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, sources: data || [] }, 200);
    }

    if (action === "set_source") {
      if (!auth.isAdmin) return json({ error: "Admin access required." }, 403);
      const userId = String(body.user_id || "");
      if (!userId) return json({ error: "Missing user_id." }, 400);

      const { data: prof, error: pErr } = await sb
        .from("profiles").select("id,email,status").eq("id", userId).maybeSingle();
      if (pErr) return json({ error: pErr.message }, 500);
      if (!prof) return json({ error: "No such profile." }, 404);
      if (prof.status !== "active") return json({ error: "That profile is not active." }, 400);
      if (!prof.email) return json({ error: "That profile has no email address." }, 400);

      const patch: Record<string, unknown> = {
        user_id: userId,
        email: prof.email,
        enabled: !!body.enabled,
        updated_at: new Date().toISOString(),
      };
      if (typeof body.query_extra === "string") {
        patch.query_extra = body.query_extra.trim().slice(0, 200) || null;
      }
      const { error } = await sb.from("christies_sources").upsert(patch, { onConflict: "user_id" });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, source: patch }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
