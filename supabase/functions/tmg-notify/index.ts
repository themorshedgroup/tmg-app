// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: tmg-notify
// Two internal-only email notifications for Symon, delivered as
// operations@themorshedgroup.com:
//
//   meeting notices — whenever Tarek's calendar shows a meeting with at
//     least one active operations-access team member (recurring series
//     excluded — see detectMeetings below).
//   EOD task digest — once a day, every task completed that day, grouped
//     by who completed it.
//
// Both emails render inside the Navy Edge shell (TMG-internal-notification-
// email-build-spec.md, 8 Sep 2026) — same header/footer/logo as every other
// TMG internal notification, title word swapped per message type.
//
// Recipient is Symon only (manager@themorshedgroup.com) — his explicit call,
// not the meeting's other attendee. Nothing external ever receives either
// email; both are gated to profiles.access, never to a Google contact.
//
// Deploy: `supabase functions deploy tmg-notify --no-verify-jwt`
//   "Verify JWT" must be OFF — `sync_meetings` and `send_task_digest` are
//   cron-invoked with a shared secret and no user session. Every OTHER
//   action still verifies a real Supabase admin session itself, below.
//
// Secrets:
//   TMG_NOTIFY_CRON_SECRET = long random string; only this function and its
//                            pg_cron jobs know it.
//   GCAL_SA_CLIENT_EMAIL   } the SAME Team Calendar service account —
//   GCAL_SA_PRIVATE_KEY    } reused here for Gmail send, not recreated.
//   GOOGLE_CLIENT_SECRET   = same OAuth client as google-calendar (reads
//                            Tarek's calendar with HIS refresh token)
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// ── The one manual step this needs, that no code here can do ──────────────
// Sending mail "as" operations@themorshedgroup.com requires Google Workspace
// domain-wide delegation for gmail.send, authorized for this SAME service
// account's client id (Admin console → Security → API controls →
// Domain-wide Delegation → find the existing GCAL_SA client id → add scope
// https://www.googleapis.com/auth/gmail.send). The calendar scope already
// authorized for that client id does NOT cover Gmail — scopes are additive,
// authorized one at a time, per client id. Until that box is checked, every
// send in this file fails with a clear, non-fatal "insufficient
// authentication scopes" error — logged, not silently swallowed, and safe
// to leave cron-scheduled while waiting on it.
//
// ── Reading Tarek's calendar ────────────────────────────────────────────
// Per-user refresh token in google_tokens (the same one google-calendar and
// christies-events already use) — no domain-wide delegation needed for this
// half. Tarek revoking his own Google connection stops this immediately, on
// his authority, same as every other per-user integration in this app.
//
// POST actions:
//   { action: 'sync_meetings' }        → cron or admin; detects + emails new/rescheduled meetings
//   { action: 'preview_meetings' }     → admin; same detection, sends nothing, writes nothing
//   { action: 'send_task_digest' }     → cron or admin; emails today's completed-tasks digest
//   { action: 'preview_task_digest' }  → admin; same content, sends nothing, writes nothing
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { LOGO_SRC } from "./logo-asset.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const GOOGLE_CLIENT_ID = "931478099859-9jifv0fl9v3s67oc7pa5ka6j61eeujfq.apps.googleusercontent.com";

// Fixed identities. Not secrets — an email address isn't sensitive, the
// private key is. Hardcoded so this never silently drifts if GCAL_SA_SUBJECT
// (used by google-calendar for calendar impersonation) ever changes for an
// unrelated reason.
const NOTIFY_FROM_EMAIL = "operations@themorshedgroup.com";
const NOTIFY_FROM_NAME = "The Morshed Group Operations";
const RECIPIENT_EMAIL = "manager@themorshedgroup.com"; // Symon — his call, 2026-09-08

const DEFAULT_TZ = "America/Chicago";
const LOOKAHEAD_DAYS = 60;   // how far forward to watch Tarek's calendar
const LOOKBACK_HOURS = 6;    // catch a same-day meeting booked shortly before it starts

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

async function authorizeCaller(req: Request) {
  const sb = serviceClient();
  if (!sb) return { ok: false as const, status: 500, error: "Server auth not configured." };
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false as const, status: 401, error: "Sign in required." };
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return { ok: false as const, status: 401, error: "Invalid or expired session." };
  const { data: profile, error: pErr } = await sb
    .from("profiles").select("status, access").eq("id", user.id).single();
  if (pErr || !profile) return { ok: false as const, status: 403, error: "Account pending approval." };
  if (profile.status !== "active") return { ok: false as const, status: 403, error: "Account is not active." };
  const roles: string[] = Array.isArray(profile.access) ? profile.access : (profile.access ? [profile.access] : []);
  return { ok: true as const, userId: user.id, isAdmin: roles.includes("admin"), sb };
}

function requireCronOrAdmin(req: Request, secretName: string) {
  const secret = Deno.env.get(secretName) || "";
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return !!(secret && bearer && bearer === secret);
}

// ── Google: user refresh token → access token (verbatim pattern from google-calendar) ──
async function googleAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "Failed to refresh Google token");
  return data.access_token;
}
async function userAccessToken(sb: any, userId: string): Promise<string> {
  const { data: row, error } = await sb.from("google_tokens").select("refresh_token").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("google_tokens read failed: " + error.message);
  if (!row?.refresh_token) throw new Error("needs_connect");
  try { return await googleAccessToken(row.refresh_token); }
  catch (e) { throw new Error("needs_connect: " + String((e as any)?.message || e)); }
}

// ── Service-account token for Gmail send-as (separate scope + subject from
// the Team Calendar helper in google-calendar/christies-events — that one is
// calendar-scoped and impersonates whatever GCAL_SA_SUBJECT holds; this one
// is gmail.send-scoped and impersonates operations@ specifically) ──
function b64url(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
let _gmailSaCache: { token: string; exp: number } | null = null;
async function gmailServiceAccountToken(): Promise<string> {
  const email = Deno.env.get("GCAL_SA_CLIENT_EMAIL");
  let key = Deno.env.get("GCAL_SA_PRIVATE_KEY") || "";
  if (!email || !key) throw new Error("notify_not_configured");
  key = key.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  if (_gmailSaCache && _gmailSaCache.exp > now + 60) return _gmailSaCache.token;
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: "https://www.googleapis.com/auth/gmail.send",
    sub: NOTIFY_FROM_EMAIL, // impersonate operations@ specifically for this send
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  };
  const te = new TextEncoder();
  const unsigned = b64url(te.encode(JSON.stringify(header))) + "." + b64url(te.encode(JSON.stringify(claim)));
  const pk = await importPkcs8(key);
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, pk, te.encode(unsigned));
  const jwt = unsigned + "." + b64url(new Uint8Array(sig));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    // The expected failure until the Admin-console scope is granted — surfaced
    // verbatim so it's diagnosable from the run log, not swallowed.
    throw new Error(data.error_description || data.error || "Gmail service-account token failed");
  }
  _gmailSaCache = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) };
  return data.access_token;
}

function rfc2047(name: string): string {
  // Encode a display name that may contain non-ASCII (not needed today, but
  // this From/To pair is fixed English text — kept for correctness, not
  // dead code: a future recipient rename must not silently mangle headers).
  return /^[\x00-\x7F]*$/.test(name) ? name : "=?UTF-8?B?" + btoa(unescape(encodeURIComponent(name))) + "?=";
}
async function sendGmail(subject: string, html: string, text: string, cc?: string[]): Promise<string> {
  const token = await gmailServiceAccountToken();
  const boundary = "tmg_" + crypto.randomUUID().replace(/-/g, "");
  const ccLine = cc && cc.length ? [`Cc: ${cc.join(", ")}`] : [];
  const raw = [
    `From: ${rfc2047(NOTIFY_FROM_NAME)} <${NOTIFY_FROM_EMAIL}>`,
    `To: ${RECIPIENT_EMAIL}`,
    ...ccLine,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    ``,
    text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset="UTF-8"`,
    ``,
    html,
    ``,
    `--${boundary}--`,
  ].join("\r\n");
  const encoded = btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || ("Gmail send failed (HTTP " + res.status + ")"));
  return data?.id || "";
}

// ── Timezone-aware "today" boundary (America/Chicago), same technique as
// the Christie's crawler's zonedToUtcMs ──
function centralDayBoundsUtc(nowMs: number): { startUtc: string; endUtc: string; label: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "01";
  const y = +g("year"), mo = +g("month"), d = +g("day");
  const naiveStart = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const offsetMs = (() => {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(naiveStart));
    const gg = (t: string) => Number(dtf.find((p) => p.type === t)?.value || 0);
    const asUtc = Date.UTC(gg("year"), gg("month") - 1, gg("day"), gg("hour") % 24, gg("minute"), gg("second"));
    return asUtc - naiveStart;
  })();
  const startUtcMs = naiveStart - offsetMs;
  const endUtcMs = startUtcMs + 86400000;
  const label = new Date(startUtcMs).toLocaleDateString("en-US", { timeZone: DEFAULT_TZ, weekday: "long", month: "long", day: "numeric", year: "numeric" });
  return { startUtc: new Date(startUtcMs).toISOString(), endUtc: new Date(endUtcMs).toISOString(), label };
}

// ── Meeting-notice email, matching Google Calendar's own reminder template ──
// "New Operations Meeting - MM/DD - HH:MM | (Event title)" — 24-hour clock,
// in the event's own time zone (falls back to Central).
function meetingSubject(startIso: string, tz: string | null, summary: string): string {
  const zone = tz || DEFAULT_TZ;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(startIso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value || "";
  return `New Operations Meeting - ${g("month")}/${g("day")} - ${g("hour")}:${g("minute")} | ${summary}`;
}
function fmtEventWhen(startIso: string, endIso: string | null, allDay: boolean, tz: string | null): string {
  const zone = tz || DEFAULT_TZ;
  // toLocaleDateString inserts a comma after the weekday ("Monday, May 18,
  // 2026"); Google's own reminder email omits that one ("Monday May 18,
  // 2026") — matched exactly since this is the template Symon pointed at.
  const noCommaWeekday = (d: Date, tzForFormat: string) =>
    d.toLocaleDateString("en-US", { timeZone: tzForFormat, weekday: "long", month: "long", day: "numeric", year: "numeric" })
      .replace(/^(\w+),/, "$1");

  if (allDay) {
    // An all-day event's date is a CALENDAR date, not an instant — running it
    // through a timeZone conversion can shift it a day (e.g. 2026-06-01T00:00Z
    // reads as May 31 in Central). Build the date directly from the Y-M-D that
    // detectMeetings encoded, in UTC, so no timezone math touches it.
    const d = new Date(startIso);
    return noCommaWeekday(d, "UTC");
  }
  const start = new Date(startIso);
  const dateStr = noCommaWeekday(start, zone);
  const timeFmt = (d: Date) => d.toLocaleTimeString("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" })
    .replace(" ", "").toLowerCase().replace(":00", ""); // "10:30am", "12pm"
  const startTime = timeFmt(start);
  const endTime = endIso ? timeFmt(new Date(endIso)) : null;
  const zoneLabel = zone === "America/Chicago" ? "Central Time - Chicago" : zone;
  return dateStr + " · " + startTime + (endTime ? " – " + endTime : "") + " (" + zoneLabel + ")";
}
function escapeHtml(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
// ── Navy Edge shell (TMG-internal-notification-email-build-spec.md v1.0) ──
// Header/footer/logo never change between messages — only the title word
// and the body slot do. Title word must stay to two words (spec §1) so it
// never wraps under the logo at 320px.
const BODY_FONT = "'Jost','Helvetica Neue',Arial,sans-serif";
function shellHtml(titleWord: string, bodyHtml: string): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:#EDECE7;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border-collapse:collapse;">
        <tr>
          <td height="3" bgcolor="#001A4A" style="height:3px;line-height:3px;font-size:0;background-color:#001A4A;">&nbsp;</td>
        </tr>
        <tr>
          <td style="padding:20px 28px;border-bottom:1px solid #E4DFD4;background-color:#FFFFFF;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="left" valign="middle" style="width:99px;">
                  <img src="${LOGO_SRC}" width="99" height="62" alt="Morshed Real Estate Group, Christie's International Real Estate" style="display:block;width:99px;height:62px;border:0;outline:none;text-decoration:none;">
                </td>
                <td align="right" valign="middle" style="font-family:${BODY_FONT};font-size:10px;font-weight:600;letter-spacing:2.2px;text-transform:uppercase;color:#001A4A;white-space:nowrap;">${escapeHtml(titleWord)}</td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:32px 28px;background-color:#FFFFFF;font-family:${BODY_FONT};font-size:15px;font-weight:300;line-height:1.7;color:#1A1A1A;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td bgcolor="#F3EBDA" style="padding:20px 28px;background-color:#F3EBDA;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="left" valign="middle" style="font-family:${BODY_FONT};font-size:10px;font-weight:400;letter-spacing:2.6px;text-transform:uppercase;color:#001A4A;">The Morshed Group</td>
                <td align="right" valign="middle" style="font-family:${BODY_FONT};font-size:11.5px;font-weight:300;color:#7A6A48;">Internal Notification &middot; Austin, Texas</td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`.trim();
}

function meetingNoticeHtml(ev: {
  summary: string; whenText: string; organizerName: string; organizerEmail: string;
  guestNames: string[]; htmlLink: string;
}): string {
  const guestsText = ev.guestNames.length ? ev.guestNames.map(escapeHtml).join(", ") : "—";
  const body = `
    <p style="margin:0 0 16px;"><strong>${escapeHtml(ev.summary)}</strong><br>${escapeHtml(ev.whenText)}</p>
    <p style="margin:0 0 16px;">Organizer: ${escapeHtml(ev.organizerName)} (${escapeHtml(ev.organizerEmail)})<br>Guests: ${guestsText}</p>
    <p style="margin:24px 0 0;"><a href="${escapeHtml(ev.htmlLink)}" style="color:#001A4A;">View full event details</a></p>`;
  return shellHtml("New Operations Meeting", body);
}
function meetingNoticeText(ev: {
  summary: string; whenText: string; organizerName: string; organizerEmail: string;
  guestNames: string[]; htmlLink: string;
}): string {
  const guests = ev.guestNames.length ? ev.guestNames.join(", ") : "—";
  return [
    "TMG — New Operations Meeting",
    "",
    ev.summary,
    ev.whenText,
    "",
    `Organizer: ${ev.organizerName} (${ev.organizerEmail})`,
    `Guests: ${guests}`,
    "",
    `View full event details: ${ev.htmlLink}`,
  ].join("\n");
}

// ── EOD task digest email ──
function taskDigestHtml(dayLabel: string, byPerson: Array<{ name: string; tasks: string[] }>): string {
  const rows = byPerson.map((p) => `
    <p style="margin:0 0 4px;font-weight:600;color:#001A4A;">${escapeHtml(p.name)} <span style="font-weight:300;color:#7A6A48;">(${p.tasks.length})</span></p>
    <p style="margin:0 0 16px;">${p.tasks.map(escapeHtml).join("<br>")}</p>`).join("");
  const body = `
    <p style="margin:0 0 16px;">Team,</p>
    <p style="margin:0 0 16px;">${escapeHtml(dayLabel)} — completed tasks below.</p>
    ${byPerson.length ? rows : `<p style="margin:0;">No tasks were marked done today.</p>`}`;
  return shellHtml("Daily Digest", body);
}
function taskDigestText(dayLabel: string, byPerson: Array<{ name: string; tasks: string[] }>): string {
  const lines = [`TMG — Completed today`, dayLabel, ""];
  if (!byPerson.length) {
    lines.push("No tasks were marked done today.");
  } else {
    for (const p of byPerson) {
      lines.push(`${p.name} (${p.tasks.length})`);
      for (const t of p.tasks) lines.push(`  - ${t}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════
// Meeting detection: Tarek's calendar → operations-access attendees
// ═════════════════════════════════════════════════════════════════════════
async function findTarek(sb: any): Promise<{ id: string; email: string } | null> {
  const { data } = await sb.from("profiles").select("id,email")
    .eq("status", "active").ilike("first_name", "tarek").limit(1).maybeSingle();
  return data ? { id: data.id, email: (data.email || "").toLowerCase() } : null;
}
async function opsRoster(sb: any): Promise<Map<string, string>> {
  // email (lowercase) -> "First Last"
  const { data } = await sb.from("profiles")
    .select("first_name,last_name,email,access,status")
    .eq("status", "active");
  const m = new Map<string, string>();
  for (const p of data || []) {
    const roles: string[] = Array.isArray(p.access) ? p.access : [];
    if (!roles.includes("operations")) continue;
    if (!p.email) continue;
    m.set(String(p.email).toLowerCase(), [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || p.email);
  }
  return m;
}

async function detectMeetings(sb: any, tarek: { id: string; email: string }, roster: Map<string, string>) {
  const token = await userAccessToken(sb, tarek.id); // throws needs_connect
  const nowMs = Date.now();
  const timeMin = new Date(nowMs - LOOKBACK_HOURS * 3600000).toISOString();
  const timeMax = new Date(nowMs + LOOKAHEAD_DAYS * 86400000).toISOString();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || ("Calendar list failed (HTTP " + r.status + ")"));

  const found: any[] = [];
  for (const ev of d.items || []) {
    if (ev.status === "cancelled") continue;
    // Skip anything that's part of a recurring series — structural, not a
    // name list, so a new standing meeting is excluded automatically too.
    // Symon's ask was "a meeting set", i.e. something new — not a re-run of
    // Tarek's FR, Team-wide Huddle, Operations Weekly Sync, etc. every week.
    if (ev.recurringEventId) continue;
    const attendees: any[] = ev.attendees || [];
    // Only count attendees who haven't declined; the organizer isn't always
    // in `attendees` (Google omits self sometimes), so also accept ev.organizer.
    const opsMatches = new Set<string>();
    for (const a of attendees) {
      const em = String(a.email || "").toLowerCase();
      if (a.responseStatus === "declined") continue;
      if (roster.has(em) && em !== tarek.email) opsMatches.add(em);
    }
    const orgEmail = String(ev.organizer?.email || "").toLowerCase();
    if (roster.has(orgEmail) && orgEmail !== tarek.email) opsMatches.add(orgEmail);
    if (!opsMatches.size) continue;
    // Must actually involve Tarek — organizer is him, or he's a non-declined attendee.
    const tarekInvolved = orgEmail === tarek.email ||
      attendees.some((a: any) => String(a.email || "").toLowerCase() === tarek.email && a.responseStatus !== "declined");
    if (!tarekInvolved) continue;

    const startIso = ev.start?.dateTime || (ev.start?.date ? ev.start.date + "T00:00:00" : null);
    const endIso = ev.end?.dateTime || (ev.end?.date ? ev.end.date + "T00:00:00" : null);
    if (!startIso) continue;
    found.push({
      id: ev.id,
      summary: ev.summary || "(no title)",
      startIso: ev.start?.dateTime || new Date(ev.start.date + "T00:00:00Z").toISOString(),
      endIso: ev.end?.dateTime || (ev.end?.date ? new Date(ev.end.date + "T00:00:00Z").toISOString() : null),
      allDay: !ev.start?.dateTime,
      timeZone: ev.start?.timeZone || null,
      location: ev.location || null,
      htmlLink: ev.htmlLink || "",
      organizerName: ev.organizer?.displayName || (orgEmail === tarek.email ? "Tarek Morshed" : orgEmail),
      organizerEmail: ev.organizer?.email || "",
      guestNames: Array.from(opsMatches).map((em) => roster.get(em) || em),
      guestEmails: Array.from(opsMatches),
    });
  }
  return found;
}

// ═════════════════════════════════════════════════════════════════════════
// Task digest: everything marked done today, grouped by assignee
// ═════════════════════════════════════════════════════════════════════════
async function buildTaskDigest(sb: any) {
  const bounds = centralDayBoundsUtc(Date.now());
  const { data: tasks, error } = await sb
    .from("tasks")
    .select("id,title,completed_at")
    .eq("status", "done")
    .gte("completed_at", bounds.startUtc)
    .lt("completed_at", bounds.endUtc);
  if (error) throw new Error("tasks read failed: " + error.message);

  const taskIds = (tasks || []).map((t: any) => t.id);
  let peopleByTask = new Map<string, string[]>();
  if (taskIds.length) {
    const { data: tp, error: tpErr } = await sb
      .from("task_people").select("task_id,user_id").eq("role", "assignee").in("task_id", taskIds);
    if (tpErr) throw new Error("task_people read failed: " + tpErr.message);
    const userIds = Array.from(new Set((tp || []).map((r: any) => r.user_id)));
    const { data: profs } = userIds.length
      ? await sb.from("profiles").select("id,first_name,last_name").in("id", userIds)
      : { data: [] };
    const nameById = new Map<string, string>();
    for (const p of profs || []) nameById.set(p.id, [p.first_name, p.last_name].filter(Boolean).join(" ").trim() || "Unknown");
    for (const r of tp || []) {
      const arr = peopleByTask.get(r.task_id) || [];
      arr.push(nameById.get(r.user_id) || "Unassigned");
      peopleByTask.set(r.task_id, arr);
    }
  }

  const byPerson = new Map<string, string[]>();
  for (const t of tasks || []) {
    const names = peopleByTask.get(t.id);
    const owners = names && names.length ? names : ["Unassigned"];
    for (const name of owners) {
      const arr = byPerson.get(name) || [];
      arr.push(t.title || "(untitled task)");
      byPerson.set(name, arr);
    }
  }
  const grouped = Array.from(byPerson.entries())
    .map(([name, taskTitles]) => ({ name, tasks: taskTitles }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { dayLabel: bounds.label, grouped, totalTasks: (tasks || []).length, totalPeople: grouped.length };
}

// ═════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    if (!action) return json({ error: "Missing action." }, 400);

    const sb = serviceClient();
    if (!sb) return json({ error: "server not configured" }, 500);

    // ── Meeting notices ─────────────────────────────────────────────────
    if (action === "sync_meetings" || action === "preview_meetings") {
      const dryRun = action === "preview_meetings";
      // Same gate for the read-only preview as the live run — cron secret or
      // an admin session — matching every other preview action in this app
      // (christies-events, ctc-emails): a dry run still needs Tarek's calendar
      // and the ops roster, so it is not meaningfully "more open" than sync.
      if (!requireCronOrAdmin(req, "TMG_NOTIFY_CRON_SECRET")) {
        const auth = await authorizeCaller(req);
        if (!auth.ok) return json({ error: "unauthorized" }, 401);
        if (!auth.isAdmin) return json({ error: "Admin access required." }, 403);
      }

      const tarek = await findTarek(sb);
      if (!tarek) return json({ error: "No active profile named Tarek found." }, 404);
      const roster = await opsRoster(sb);

      let meetings: any[];
      try {
        meetings = await detectMeetings(sb, tarek, roster);
      } catch (e) {
        return json({ error: String((e as any)?.message || e) }, 502);
      }

      const results: any[] = [];
      for (const m of meetings) {
        const { data: existing } = await sb
          .from("tmg_meeting_notices").select("google_event_id,notified_start_at").eq("google_event_id", m.id).maybeSingle();
        const isNew = !existing;
        const rescheduled = !!existing && existing.notified_start_at && existing.notified_start_at !== m.startIso;
        if (!isNew && !rescheduled) { results.push({ action: "unchanged", title: m.summary }); continue; }

        const whenText = fmtEventWhen(m.startIso, m.endIso, m.allDay, m.timeZone);
        if (dryRun) {
          results.push({
            action: isNew ? "would_notify" : "would_notify_reschedule",
            title: m.summary, when: whenText, organizer: m.organizerName,
            guests: m.guestNames, location: m.location,
          });
          continue;
        }
        try {
          const subject = (rescheduled ? "Rescheduled: " : "") + meetingSubject(m.startIso, m.timeZone, m.summary);
          const noticeArgs = {
            summary: m.summary, whenText, organizerName: m.organizerName, organizerEmail: m.organizerEmail,
            guestNames: m.guestNames, htmlLink: m.htmlLink,
          };
          await sendGmail(subject, meetingNoticeHtml(noticeArgs), meetingNoticeText(noticeArgs), m.guestEmails);
          await sb.from("tmg_meeting_notices").upsert({
            google_event_id: m.id, event_summary: m.summary, event_start: m.startIso, event_end: m.endIso,
            all_day: m.allDay, time_zone: m.timeZone, location: m.location, html_link: m.htmlLink,
            organizer_name: m.organizerName, organizer_email: m.organizerEmail,
            attendee_names: m.guestNames.join(", "), notified_at: new Date().toISOString(), notified_start_at: m.startIso,
          }, { onConflict: "google_event_id" });
          results.push({ action: isNew ? "notified" : "notified_reschedule", title: m.summary });
        } catch (e) {
          results.push({ action: "error", title: m.summary, error: String((e as any)?.message || e) });
        }
      }
      return json({ ok: true, dry_run: dryRun, tarek_email: tarek.email, ops_roster: Array.from(roster.values()), results }, 200);
    }

    // ── EOD task digest ─────────────────────────────────────────────────
    if (action === "send_task_digest" || action === "preview_task_digest") {
      const dryRun = action === "preview_task_digest";
      if (!requireCronOrAdmin(req, "TMG_NOTIFY_CRON_SECRET")) {
        const auth = await authorizeCaller(req);
        if (!auth.ok) return json({ error: "unauthorized" }, 401);
        if (!auth.isAdmin) return json({ error: "Admin access required." }, 403);
      }

      let digest;
      try { digest = await buildTaskDigest(sb); }
      catch (e) { return json({ error: String((e as any)?.message || e) }, 500); }

      if (dryRun) {
        return json({ ok: true, dry_run: true, day: digest.dayLabel, total_tasks: digest.totalTasks, by_person: digest.grouped }, 200);
      }

      const bounds = centralDayBoundsUtc(Date.now());
      const digestDate = bounds.startUtc.slice(0, 10);
      const { data: already } = await sb.from("tmg_task_digests").select("digest_date").eq("digest_date", digestDate).maybeSingle();
      if (already) return json({ ok: true, skipped: "already_sent_today", day: digest.dayLabel }, 200);

      try {
        await sendGmail(
          "TMG — " + digest.totalTasks + " task" + (digest.totalTasks === 1 ? "" : "s") + " completed today",
          taskDigestHtml(digest.dayLabel, digest.grouped),
          taskDigestText(digest.dayLabel, digest.grouped),
        );
        await sb.from("tmg_task_digests").insert({
          digest_date: digestDate, tasks_count: digest.totalTasks, people_count: digest.totalPeople,
        });
      } catch (e) {
        return json({ error: String((e as any)?.message || e) }, 502);
      }
      return json({ ok: true, day: digest.dayLabel, total_tasks: digest.totalTasks, by_person: digest.grouped }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
