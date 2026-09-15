// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: tmg-calendar-summary
// Broadcasts the shared Team Calendar to the whole team, twice on a fixed
// schedule (no filtering — every event on the calendar is included):
//
//   weekly  — sent every Thursday, covers the coming Monday-Sunday.
//   monthly — sent on the last day of the month, covers the coming month.
//
// Sent individually to every active profile (their own email as "To:" —
// no BCC, no shared broadcast) so each person's copy can show THEIR OWN
// RSVP status. Recipients are derived live from active profiles, never a
// hardcoded list, so a new hire is included automatically and someone who
// leaves drops off on their own.
//
// RSVP: each event carries a rounded Yes/Maybe/No control — rsvp.html
// (same-origin as the app, so it reuses whoever is already logged in, no
// signed token) records the click, and the option matching the reader's
// own current response (2026-09-16, Symon's call) renders filled-in on
// their copy specifically. Every event also shows the team-wide tally
// ("2 yes · 1 maybe"), re-queried from tmg_event_rsvps at send time — one
// query shared across all N personalized sends, not N queries.
//
// Deploy: `supabase functions deploy tmg-calendar-summary --no-verify-jwt`
//   "Verify JWT" must be OFF — send_weekly/send_monthly are cron-invoked
//   with a shared secret and no user session. preview_* still require a
//   real admin session, checked below.
//
// Secrets:
//   TMG_CALENDAR_SUMMARY_CRON_SECRET = long random string; only this
//                                      function and its two pg_cron jobs
//                                      know it.
//   GCAL_SA_CLIENT_EMAIL  } the Team Calendar service account — same one
//   GCAL_SA_PRIVATE_KEY   } time-off / christies-events already use to read
//   GCAL_SA_SUBJECT       } it (calendar is shared with the SA directly, no
//                            impersonation needed for this read).
//   GCAL_SA_CLIENT_EMAIL / GCAL_SA_PRIVATE_KEY are ALSO reused for Gmail
//   send (gmail.send, impersonating operations@) — same secrets as
//   tmg-notify, not duplicated as new ones.
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// POST actions:
//   { action: 'preview_weekly' }  → admin; builds the coming Mon-Sun email, sends/logs nothing
//   { action: 'send_weekly' }     → cron or admin; sends it to every active profile, logs the send
//   { action: 'preview_monthly' } → admin; builds the coming month's email, sends/logs nothing
//   { action: 'send_monthly' }    → cron or admin; sends it, logs the send
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

const DEFAULT_TZ = "America/Chicago";
const TEAM_CALENDAR_ID = "c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com";
const APP_ORIGIN = "https://app.themorshedgroup.com";

const NOTIFY_FROM_EMAIL = "operations@themorshedgroup.com";
const NOTIFY_FROM_NAME = "The Morshed Group Operations";

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

async function authorizeAdmin(req: Request) {
  const sb = serviceClient();
  if (!sb) return { ok: false as const, status: 500, error: "Server auth not configured." };
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false as const, status: 401, error: "Sign in required." };
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return { ok: false as const, status: 401, error: "Invalid or expired session." };
  const { data: profile, error: pErr } = await sb
    .from("profiles").select("status, access").eq("id", user.id).single();
  if (pErr || !profile || profile.status !== "active") return { ok: false as const, status: 403, error: "Account is not active." };
  const roles: string[] = Array.isArray(profile.access) ? profile.access : (profile.access ? [profile.access] : []);
  if (!roles.includes("admin")) return { ok: false as const, status: 403, error: "Admin only." };
  return { ok: true as const, sb, userId: user.id };
}
function requireCronOrAdmin(req: Request, secretName: string) {
  const secret = Deno.env.get(secretName) || "";
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return !!(secret && bearer && bearer === secret);
}

// ── Google service-account token (calendar read — team calendar is shared
// directly with this SA, so no impersonation is needed for reads even
// though GCAL_SA_SUBJECT exists for other callers). Duplicated verbatim
// from christies-events/index.ts — edge functions deploy as independent
// bundles, so this is copied on purpose, not imported. ──
function b64url(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
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
    iss: email, scope: "https://www.googleapis.com/auth/calendar",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
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
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "Service-account token failed");
  _saCache = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) };
  return data.access_token;
}

// ── Gmail send-as, gmail.send scope impersonating operations@ — same
// secrets/pattern as tmg-notify's gmailServiceAccountToken, duplicated per
// the same self-contained-bundle convention. ──
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
    iss: email, scope: "https://www.googleapis.com/auth/gmail.send",
    sub: NOTIFY_FROM_EMAIL, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
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
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "Gmail service-account token failed");
  _gmailSaCache = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) };
  return data.access_token;
}
async function sendGmail(toList: string[], subject: string, html: string, text: string): Promise<string> {
  const token = await gmailServiceAccountToken();
  const boundary = "tmg_" + crypto.randomUUID().replace(/-/g, "");
  const raw = [
    `From: ${NOTIFY_FROM_NAME} <${NOTIFY_FROM_EMAIL}>`,
    `To: ${toList.join(", ")}`,
    `Subject: =?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`, `Content-Type: text/plain; charset="UTF-8"`, ``, text, ``,
    `--${boundary}`, `Content-Type: text/html; charset="UTF-8"`, ``, html, ``,
    `--${boundary}--`,
  ].join("\r\n");
  const encoded = btoa(unescape(encodeURIComponent(raw))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || ("Gmail send failed (HTTP " + res.status + ")"));
  return data?.id || "";
}

// ── Date-range math, both in Central time ──
function centralParts(ms: number) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +g("year"), mo: +g("month"), d: +g("day"), dow: dowMap[g("weekday")] };
}
// A Y/M/D calendar date in Central, expressed as its UTC midnight instant —
// good enough for day-boundary math (timeMin/timeMax), not for exact instants.
function centralDateToUtc(y: number, mo: number, d: number): number {
  const naive = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: DEFAULT_TZ, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(naive));
  const gg = (t: string) => Number(dtf.find((x) => x.type === t)?.value || 0);
  const asUtc = Date.UTC(gg("year"), gg("month") - 1, gg("day"), gg("hour") % 24, gg("minute"), gg("second"));
  const offset = asUtc - naive;
  return naive - offset;
}
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// Coming Monday-Sunday. Cron fires Thursdays only, so "coming" always means
// 4 days out — but this stays correct if run any other day (preview), always
// resolving to the NEXT Monday strictly after today.
function weeklyRange(nowMs: number) {
  const { y, mo, d, dow } = centralParts(nowMs);
  const daysUntilMonday = ((1 - dow + 7) % 7) || 7;
  const mondayUtc = centralDateToUtc(y, mo, d) + daysUntilMonday * 86400000;
  const sundayEndUtc = mondayUtc + 7 * 86400000; // exclusive upper bound
  const mondayParts = centralParts(mondayUtc);
  const sundayParts = centralParts(sundayEndUtc - 86400000);
  const sameMonth = mondayParts.mo === sundayParts.mo;
  const dateLine = sameMonth
    ? `${MONTH_NAMES[mondayParts.mo - 1]} ${String(mondayParts.d).padStart(2, "0")} - ${String(sundayParts.d).padStart(2, "0")}`
    : `${MONTH_NAMES[mondayParts.mo - 1]} ${String(mondayParts.d).padStart(2, "0")} - ${MONTH_NAMES[sundayParts.mo - 1]} ${String(sundayParts.d).padStart(2, "0")}`;
  const periodKey = `${mondayParts.y}-${String(mondayParts.mo).padStart(2, "0")}-${String(mondayParts.d).padStart(2, "0")}`;
  return {
    timeMin: new Date(mondayUtc).toISOString(),
    timeMax: new Date(sundayEndUtc).toISOString(),
    dateLine, periodKey,
  };
}
// Coming calendar month. Cron fires on the last day of the month, so "coming"
// always means next month — correct on any other invocation day too.
function monthlyRange(nowMs: number) {
  const { y, mo } = centralParts(nowMs);
  const nextMo = mo === 12 ? 1 : mo + 1;
  const nextY = mo === 12 ? y + 1 : y;
  const startUtc = centralDateToUtc(nextY, nextMo, 1);
  const afterMo = nextMo === 12 ? 1 : nextMo + 1;
  const afterY = nextMo === 12 ? nextY + 1 : nextY;
  const endUtc = centralDateToUtc(afterY, afterMo, 1);
  return {
    timeMin: new Date(startUtc).toISOString(),
    timeMax: new Date(endUtc).toISOString(),
    dateLine: MONTH_NAMES[nextMo - 1],
    periodKey: `${nextY}-${String(nextMo).padStart(2, "0")}`,
  };
}

// ── Team Calendar read — every event in range, no filtering ──
async function fetchTeamEvents(timeMin: string, timeMax: string) {
  const token = await serviceAccountToken();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(TEAM_CALENDAR_ID) + "/events");
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "250");
  url.searchParams.set("timeMin", timeMin);
  url.searchParams.set("timeMax", timeMax);
  const res = await fetch(url.toString(), { headers: { Authorization: "Bearer " + token } });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Team Calendar read failed");
  return (data.items || []).map((e: any) => ({
    id: e.id as string,
    summary: (e.summary as string) || "(no title)",
    start: e.start?.dateTime || e.start?.date || null,
    end: e.end?.dateTime || e.end?.date || null,
    allDay: !!e.start?.date && !e.start?.dateTime,
    htmlLink: (e.htmlLink as string) || "",
  }));
}

function escapeHtml(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function dayLabel(dateIso: string, allDay: boolean): string {
  const d = new Date(dateIso);
  return d.toLocaleDateString("en-US", { timeZone: allDay ? "UTC" : DEFAULT_TZ, weekday: "long", month: "long", day: "numeric" });
}
function timeLabel(startIso: string, endIso: string | null, allDay: boolean): string {
  if (allDay) return "All day";
  const timeFmt = (iso: string) => new Date(iso).toLocaleTimeString("en-US", { timeZone: DEFAULT_TZ, hour: "numeric", minute: "2-digit" })
    .replace(" ", "").toLowerCase().replace(":00", "");
  return timeFmt(startIso) + (endIso ? " – " + timeFmt(endIso) : "");
}
function dayKey(dateIso: string, allDay: boolean): string {
  const d = new Date(dateIso);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: allDay ? "UTC" : DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  return p.map((x) => x.value).join("");
}

// ── Navy Edge shell — identical header/footer/logo as tmg-notify; only the
// title word and body slot differ. Duplicated (not imported) per the
// self-contained-bundle convention every function in this repo already uses. ──
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

function rsvpLink(eventId: string, r: "yes" | "no" | "maybe"): string {
  return `${APP_ORIGIN}/rsvp.html?event=${encodeURIComponent(eventId)}&r=${r}`;
}
function tallyLine(tally: Record<string, number> | undefined): string {
  if (!tally) return "";
  const parts = (["yes", "maybe", "no"] as const).filter((k) => tally[k]).map((k) => `${tally[k]} ${k}`);
  return parts.length ? parts.join(" · ") : "";
}

// One rounded, segmented Yes/Maybe/No control per event — whichever option
// matches the recipient's own current response (if any) renders filled-in;
// the other two stay outline-only. Table-based so it survives Gmail/Outlook/
// Apple Mail's inline-CSS-only rendering.
const RSVP_OPTIONS: Array<{ key: "yes" | "maybe" | "no"; label: string; color: string }> = [
  { key: "yes", label: "Yes", color: "#1B7F4D" },
  { key: "maybe", label: "Maybe", color: "#AD832F" },
  { key: "no", label: "No", color: "#B3261E" },
];
function rsvpButtonsHtml(eventId: string, current?: string): string {
  const cells = RSVP_OPTIONS.map((o, i) => {
    const selected = current === o.key;
    const bg = selected ? o.color : "#FFFFFF";
    const fg = selected ? "#FFFFFF" : o.color;
    const radius = i === 0 ? "11px 0 0 11px" : i === RSVP_OPTIONS.length - 1 ? "0 11px 11px 0" : "0";
    const borderLeft = i === 0 ? "border-left:1px solid #E4DFD4;" : "";
    return `<td style="background-color:${bg};border-top:1px solid #E4DFD4;border-bottom:1px solid #E4DFD4;border-right:1px solid #E4DFD4;${borderLeft}border-radius:${radius};">
      <a href="${rsvpLink(eventId, o.key)}" style="display:block;padding:5px 13px;font-family:${BODY_FONT};font-size:10px;font-weight:600;color:${fg};text-decoration:none;white-space:nowrap;">${o.label}</a>
    </td>`;
  }).join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border-spacing:0;"><tr>${cells}</tr></table>`;
}

function buildBodyHtml(events: any[], tallies: Record<string, Record<string, number>>, ownResponses: Record<string, string>): string {
  if (!events.length) {
    return `<p style="margin:0;color:#5f6368;">No events on the calendar for this period.</p>`;
  }
  const groups = new Map<string, any[]>();
  for (const e of events) {
    const k = dayKey(e.start, e.allDay);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(e);
  }
  const days = Array.from(groups.entries());
  return days.map(([, evs]) => {
    const heading = `<p style="margin:0 0 8px;font-weight:600;color:#001A4A;">${escapeHtml(dayLabel(evs[0].start, evs[0].allDay))}</p>`;
    const rows = evs.map((e) => {
      const t = tallyLine(tallies[e.id]);
      return `
        <div style="margin:0 0 18px;padding:0 0 18px;border-bottom:1px solid #EDECE7;">
          <div style="font-weight:500;">${escapeHtml(e.summary)}</div>
          <div style="font-size:13px;color:#5f6368;margin-top:2px;">${escapeHtml(timeLabel(e.start, e.end, e.allDay))}</div>
          ${t ? `<div style="font-size:12px;color:#7A6A48;margin-top:6px;">${escapeHtml(t)}</div>` : ""}
          <div style="margin-top:10px;">${rsvpButtonsHtml(e.id, ownResponses[e.id])}</div>
        </div>`;
    }).join("");
    return heading + rows;
  }).join("");
}
function buildBodyText(events: any[], tallies: Record<string, Record<string, number>>, ownResponses: Record<string, string>): string {
  if (!events.length) return "No events on the calendar for this period.";
  return events.map((e) => {
    const t = tallyLine(tallies[e.id]);
    const mine = ownResponses[e.id];
    const mineLine = mine ? `Your response: ${mine.charAt(0).toUpperCase()}${mine.slice(1)}\n` : "";
    return `${dayLabel(e.start, e.allDay)} — ${e.summary}\n${timeLabel(e.start, e.end, e.allDay)}${t ? "  (" + t + ")" : ""}\n${mineLine}RSVP: Yes ${rsvpLink(e.id, "yes")}  Maybe ${rsvpLink(e.id, "maybe")}  No ${rsvpLink(e.id, "no")}`;
  }).join("\n\n");
}

// One query for every RSVP row touching this period's events — reused to
// derive BOTH the team-wide tally and each recipient's own status, so
// personalizing N emails costs one extra query total, not N.
async function fetchRsvpRows(sb: any, eventIds: string[]): Promise<Array<{ google_event_id: string; profile_id: string; response: string }>> {
  if (!eventIds.length) return [];
  const { data, error } = await sb.from("tmg_event_rsvps").select("google_event_id, profile_id, response").in("google_event_id", eventIds);
  if (error || !data) return [];
  return data as any[];
}
function talliesFromRows(rows: Array<{ google_event_id: string; response: string }>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    out[row.google_event_id] = out[row.google_event_id] || {};
    out[row.google_event_id][row.response] = (out[row.google_event_id][row.response] || 0) + 1;
  }
  return out;
}
function ownResponsesFromRows(rows: Array<{ google_event_id: string; profile_id: string; response: string }>, profileId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) if (row.profile_id === profileId) out[row.google_event_id] = row.response;
  return out;
}
async function activeRecipients(sb: any): Promise<Array<{ id: string; email: string }>> {
  const { data } = await sb.from("profiles").select("id, email").eq("status", "active");
  const seen = new Set<string>();
  const out: Array<{ id: string; email: string }> = [];
  for (const r of (data || []) as any[]) {
    const email = (r.email || "").trim();
    if (email && !seen.has(email)) { seen.add(email); out.push({ id: r.id, email }); }
  }
  return out;
}

// Personalized per recipient (their own RSVP status highlighted) — one
// broadcast identical to everyone is no longer possible once the buttons
// reflect "your" status, so send_* now emails each recipient individually
// (see below), all built from this ONE shared events+rows fetch.
function renderEmail(range: { dateLine: string }, events: any[], tallies: Record<string, Record<string, number>>, ownResponses: Record<string, string>) {
  const titleBlock = `
    <p style="margin:0 0 24px;">
      <span style="display:block;font-size:20px;font-weight:600;color:#001A4A;">Team Calendar Summary</span>
      <span style="display:block;font-size:13px;color:#7A6A48;margin-top:4px;">${escapeHtml(range.dateLine)}</span>
    </p>`;
  const html = shellHtml("Team Calendar Summary", titleBlock + buildBodyHtml(events, tallies, ownResponses));
  const text = `Team Calendar Summary\n${range.dateLine}\n\n${buildBodyText(events, tallies, ownResponses)}`;
  const subject = `Team Calendar Summary - ${range.dateLine}`;
  return { html, text, subject };
}

async function alreadySent(sb: any, sendType: string, periodKey: string): Promise<boolean> {
  const { data } = await sb.from("tmg_calendar_summary_log").select("period_key").eq("send_type", sendType).eq("period_key", periodKey).maybeSingle();
  return !!data;
}
async function logSend(sb: any, sendType: string, periodKey: string, eventCount: number) {
  await sb.from("tmg_calendar_summary_log").insert({ send_type: sendType, period_key: periodKey, event_count: eventCount });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine for these actions */ }
  const action = body?.action;

  try {
    if (action === "preview_weekly" || action === "preview_monthly") {
      // Read-only (sends nothing, logs nothing) — cron secret OR admin session,
      // same as send_*, so this is exactly as protected as the real send.
      let sb; let asProfileId: string | null = null;
      if (requireCronOrAdmin(req, "TMG_CALENDAR_SUMMARY_CRON_SECRET")) {
        sb = serviceClient();
        if (!sb) return json({ error: "Server auth not configured." }, 500);
        // No logged-in person on the cron path — pass profile_id to preview
        // as a specific recipient, or omit for the plain (nobody-responded) view.
        asProfileId = typeof body?.profile_id === "string" ? body.profile_id : null;
      } else {
        const auth = await authorizeAdmin(req);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        sb = auth.sb;
        asProfileId = auth.userId; // preview as the admin who's looking at it
      }
      const range = action === "preview_weekly" ? weeklyRange(Date.now()) : monthlyRange(Date.now());
      const events = await fetchTeamEvents(range.timeMin, range.timeMax);
      const rows = await fetchRsvpRows(sb, events.map((e: any) => e.id));
      const tallies = talliesFromRows(rows);
      const ownResponses = asProfileId ? ownResponsesFromRows(rows, asProfileId) : {};
      const email = renderEmail(range, events, tallies, ownResponses);
      return json({ ok: true, ...email, eventCount: events.length, timeMin: range.timeMin, timeMax: range.timeMax });
    }

    if (action === "send_weekly" || action === "send_monthly") {
      const sendType = action === "send_weekly" ? "weekly" : "monthly";
      const secretName = "TMG_CALENDAR_SUMMARY_CRON_SECRET";
      const isCron = requireCronOrAdmin(req, secretName);
      let sb;
      if (isCron) {
        sb = serviceClient();
        if (!sb) return json({ error: "Server auth not configured." }, 500);
      } else {
        const auth = await authorizeAdmin(req);
        if (!auth.ok) return json({ error: auth.error }, auth.status);
        sb = auth.sb;
      }
      const range = sendType === "weekly" ? weeklyRange(Date.now()) : monthlyRange(Date.now());
      if (await alreadySent(sb, sendType, range.periodKey)) {
        return json({ ok: true, skipped: "already_sent", periodKey: range.periodKey });
      }
      const events = await fetchTeamEvents(range.timeMin, range.timeMax);
      const rows = await fetchRsvpRows(sb, events.map((e: any) => e.id));
      const tallies = talliesFromRows(rows);
      const recipients = await activeRecipients(sb);
      if (!recipients.length) return json({ error: "No active recipients found." }, 500);
      // Personalized per recipient (their own RSVP status highlighted) means
      // one shared broadcast is no longer possible — each recipient gets
      // their own Gmail send, built from the ONE shared events+rows fetch
      // above so this stays one Team Calendar read, not N.
      let sentCount = 0;
      const failures: string[] = [];
      for (const r of recipients) {
        try {
          const ownResponses = ownResponsesFromRows(rows, r.id);
          const email = renderEmail(range, events, tallies, ownResponses);
          await sendGmail([r.email], email.subject, email.html, email.text);
          sentCount++;
        } catch (e) {
          failures.push(`${r.email}: ${String((e as any)?.message || e)}`);
        }
      }
      if (sentCount === 0) return json({ error: "All sends failed.", failures }, 500);
      await logSend(sb, sendType, range.periodKey, events.length);
      return json({ ok: true, sent: true, periodKey: range.periodKey, recipients: sentCount, failed: failures.length, failures, eventCount: events.length });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
