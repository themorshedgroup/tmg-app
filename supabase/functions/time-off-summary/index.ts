// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: time-off-summary
// Monthly Time Off Summary email, sent on the 1st of every month at 7 AM
// Central to a FIXED leadership list (it shows everyone's balances, so it is
// not a team broadcast). Same Navy Edge shell, logo and Gmail sender as
// tmg-calendar-summary.
//
// Sections: balances for the year (tracked staff) · coming up (this month +
// next) · taken last month · sales agents' logged days (visibility only).
// Balance math mirrors src/timeoff.jsx (timeoffBalance / timeoffProration):
// allotment = profile.time_off_days × hours_per_workday, prorated for the
// hire year; used = approved + tracked hours whose start falls in the year.
//
// Deploy: `supabase functions deploy time-off-summary --no-verify-jwt`
//   cron-invoked with a shared secret; admin session also accepted.
//
// Secrets (reused, none new):
//   TMG_CALENDAR_SUMMARY_CRON_SECRET  shared with tmg-calendar-summary; the
//                                     pg_cron job reads it from the vault.
//   GCAL_SA_CLIENT_EMAIL / GCAL_SA_PRIVATE_KEY  Gmail send as operations@.
//
// POST actions:
//   { action: 'preview' }                → builds the email, sends nothing
//   { action: 'send_test', to: [...] }   → sends to the given addresses, logs nothing
//   { action: 'send_monthly' }           → sends to RECIPIENTS once per month (logged)
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

const TZ = "America/Chicago";
const APP_ORIGIN = "https://app.themorshedgroup.com";
const NOTIFY_FROM_EMAIL = "operations@themorshedgroup.com";
const NOTIFY_FROM_NAME = "The Morshed Group Operations";
// Symon's call, 2026-09-26.
const RECIPIENTS = ["manager@themorshedgroup.com", "tarek@themorshedgroup.com"];
// Symon's fixed roster order (matches the Time Off Team tab). Anyone new goes after, alphabetically.
const TEAM_ORDER = ["tarek", "brad", "brett", "kyle", "symon", "angelica", "alexa", "gustavo", "camila"];

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}
function isCron(req: Request) {
  const secret = Deno.env.get("TMG_CALENDAR_SUMMARY_CRON_SECRET") || "";
  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  return !!(secret && bearer && bearer === secret);
}
async function isAdmin(req: Request, sb: any) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const { data: { user } } = await sb.auth.getUser(token);
  if (!user) return false;
  const { data: p } = await sb.from("profiles").select("status, access").eq("id", user.id).single();
  const roles: string[] = Array.isArray(p?.access) ? p.access : [];
  return p?.status === "active" && roles.includes("admin");
}

// ── Gmail send as operations@ (same pattern as tmg-calendar-summary / tmg-notify) ──
function b64url(bytes: Uint8Array): string {
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
async function gmailToken(): Promise<string> {
  const email = Deno.env.get("GCAL_SA_CLIENT_EMAIL");
  let key = Deno.env.get("GCAL_SA_PRIVATE_KEY") || "";
  if (!email || !key) throw new Error("notify_not_configured");
  key = key.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  const te = new TextEncoder();
  const unsigned = b64url(te.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." + b64url(te.encode(JSON.stringify({
    iss: email, scope: "https://www.googleapis.com/auth/gmail.send", sub: NOTIFY_FROM_EMAIL,
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })));
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, await importPkcs8(key), te.encode(unsigned));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + b64url(new Uint8Array(sig)) }).toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "Gmail service-account token failed");
  return data.access_token;
}
async function sendGmail(toList: string[], subject: string, html: string, text: string, token: string) {
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
}

// ── Dates: plain Y-M-D strings in Central; request timestamps are stored
// without a zone, so their first 10 chars ARE the local date. ──
function todayCentral(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
const ymd = (y: number, m: number, d: number) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.toISOString().slice(0, 10); };
const dOnly = (v: string) => String(v || "").slice(0, 10);
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const shortDate = (s: string) => MON[+s.slice(5, 7) - 1] + " " + (+s.slice(8, 10));
function when(r: any) {
  const a = dOnly(r.start_at), b = dOnly(r.end_at);
  if (!r.full_day) {
    const t = (v: string) => { const h = +v.slice(11, 13), mi = v.slice(14, 16); return ((h % 12) || 12) + (mi === "00" ? "" : ":" + mi) + (h < 12 ? "am" : "pm"); };
    return shortDate(a) + ", " + t(String(r.start_at).replace(" ", "T")) + " – " + t(String(r.end_at).replace(" ", "T"));
  }
  return a === b ? shortDate(a) : shortDate(a) + " – " + shortDate(b);
}
function proration(hire: string | null, year: number) {
  if (!hire) return 1;
  const hy = +hire.slice(0, 4);
  if (hy < year) return 1;
  if (hy > year) return 0;
  const start = Date.UTC(year, 0, 1), end = Date.UTC(year, 11, 31);
  const h = Date.parse(dOnly(hire) + "T00:00:00Z");
  const daysInYear = Math.round((end - start) / 86400000) + 1;
  return Math.max(0, Math.min(1, (Math.round((end - h) / 86400000) + 1) / daysInYear));
}

const esc = (s: string) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const F = "'Jost','Helvetica Neue',Arial,sans-serif";
const th = (t: string, al = "left") => `<td align="${al}" style="padding:0 0 8px;font-family:${F};font-size:10px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:#7A6A48;border-bottom:1px solid #E4DFD4;">${t}</td>`;
const td = (t: string, al = "left", st = "") => `<td align="${al}" valign="top" style="padding:10px 0;font-family:${F};font-size:13px;font-weight:300;color:#1A1A1A;border-bottom:1px solid #F0EEE8;${st}">${t}</td>`;
const section = (t: string) => `<p style="margin:28px 0 10px;font-family:${F};font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#001A4A;">${t}</p>`;
const TABLE = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">`;
const STATUS: Record<string, [string, string]> = { approved: ["Approved", "#1E6B40"], pending: ["Pending", "#B07A00"], noted: ["Logged", "#AD832F"] };

function shellHtml(bodyHtml: string): string {
  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0;padding:0;background-color:#EDECE7;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:#FFFFFF;border-collapse:collapse;">
      <tr><td height="3" bgcolor="#001A4A" style="height:3px;line-height:3px;font-size:0;background-color:#001A4A;">&nbsp;</td></tr>
      <tr><td style="padding:20px 28px;border-bottom:1px solid #E4DFD4;background-color:#FFFFFF;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="left" valign="middle" style="width:99px;"><img src="${LOGO_SRC}" width="99" height="62" alt="Morshed Real Estate Group, Christie's International Real Estate" style="display:block;width:99px;height:62px;border:0;outline:none;text-decoration:none;"></td>
          <td align="right" valign="middle" style="font-family:${F};font-size:10px;font-weight:600;letter-spacing:2.2px;text-transform:uppercase;color:#001A4A;white-space:nowrap;">Time Off Summary</td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:32px 28px;background-color:#FFFFFF;font-family:${F};font-size:15px;font-weight:300;line-height:1.7;color:#1A1A1A;">
        ${bodyHtml}
      </td></tr>
      <tr><td bgcolor="#F3EBDA" style="padding:20px 28px;background-color:#F3EBDA;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td align="left" valign="middle" style="font-family:${F};font-size:10px;font-weight:400;letter-spacing:2.6px;text-transform:uppercase;color:#001A4A;">The Morshed Group</td>
          <td align="right" valign="middle" style="font-family:${F};font-size:11.5px;font-weight:300;color:#7A6A48;">Internal Notification &middot; Austin, Texas</td>
        </tr></table>
      </td></tr>
    </table>
  </td></tr>
</table>`.trim();
}

async function buildEmail(sb: any, asOf: string) {
  const year = +asOf.slice(0, 4), month = +asOf.slice(5, 7);
  // Windows: this month + next ("coming up"), last calendar month ("taken").
  const upFrom = asOf;
  const upTo = ymd(year, month + 2, 0); // last day of next month (Date.UTC rolls the year over)
  const lastFrom = month === 1 ? ymd(year - 1, 12, 1) : ymd(year, month - 1, 1);
  const lastTo = ymd(year, month, 0);
  const lastMonthName = MONTH[(month + 10) % 12];
  const nextMonthName = MONTH[month % 12];

  const { data: pol } = await sb.from("time_off_policies").select("config").eq("id", 1).maybeSingle();
  const hpw = Number(pol?.config?.hours_per_workday) > 0 ? Number(pol.config.hours_per_workday) : 8;
  const { data: profs, error: pErr } = await sb.from("profiles").select("id, first_name, last_name, email, access, status, time_off_days, hire_date");
  if (pErr) throw new Error("profiles: " + pErr.message);
  const fetchFrom = (lastFrom < `${year}-01-01` ? lastFrom : `${year}-01-01`) + "T00:00:00";
  const { data: reqs, error: rErr } = await sb.from("time_off_requests").select("*")
    .gte("start_at", fetchFrom).lte("start_at", upTo + "T23:59:59").in("status", ["approved", "pending", "noted"]);
  if (rErr) throw new Error("requests: " + rErr.message);

  const name = (p: any) => ((p.first_name || "") + " " + (p.last_name || "")).trim() || p.email || "Someone";
  const rank = (p: any) => { const f = String(p.first_name || "").toLowerCase(); const i = TEAM_ORDER.findIndex((n) => f.startsWith(n)); return i === -1 ? TEAM_ORDER.length : i; };
  // Real people only: active, with at least one role (the shared operations login has none).
  const people = (profs || [])
    .filter((p: any) => (!p.status || p.status === "active") && Array.isArray(p.access) && p.access.filter((r: string) => r && r !== "pending").length)
    .sort((a: any, b: any) => (rank(a) - rank(b)) || name(a).localeCompare(name(b)));
  const byId: Record<string, any> = {}; people.forEach((p: any) => { byId[p.id] = p; });
  const rows = (reqs || []).filter((r: any) => byId[r.user_id]);
  const fh = (h: number) => String(Math.round(h * 10) / 10);
  const hd = (h: number) => { const d = Math.round((h / hpw) * 10) / 10; return `${d} day${d === 1 ? "" : "s"} (${fh(h)}h)`; };

  // Balances (tracked staff).
  let balRows = "", balText = "";
  for (const p of people) {
    const days = Math.max(0, Number(p.time_off_days) || 0);
    if (days <= 0) continue;
    const pr = proration(p.hire_date, year);
    const allot = days * hpw * pr;
    const mine = rows.filter((r: any) => r.user_id === p.id && r.tracked && +dOnly(r.start_at).slice(0, 4) === year);
    const used = mine.filter((r: any) => r.status === "approved").reduce((s: number, r: any) => s + (Number(r.total_hours) || 0), 0);
    const pend = mine.filter((r: any) => r.status === "pending").reduce((s: number, r: any) => s + (Number(r.total_hours) || 0), 0);
    const note = pr < 1 && p.hire_date ? `<br><span style="font-size:11px;color:#AD832F;">prorated, started ${shortDate(dOnly(p.hire_date))}</span>` : "";
    balRows += "<tr>" + td(`<span style="font-weight:600;color:#001A4A;">${esc(name(p))}</span>${note}`)
      + td(`<span style="font-weight:600;color:#001A4A;">${hd(allot - used)}</span>`, "right")
      + td(hd(used), "right") + td(pend ? hd(pend) : `<span style="color:#9B9380;">none</span>`, "right") + td(hd(allot), "right") + "</tr>";
    balText += `${name(p)}: ${hd(allot - used)} left, ${hd(used)} used, ${pend ? hd(pend) : "none"} pending, of ${hd(allot)}\n`;
  }
  const balHtml = balRows
    ? TABLE + "<tr>" + th("Person") + th("Left", "right") + th("Used", "right") + th("Pending", "right") + th("Of", "right") + "</tr>" + balRows + "</table>"
    : `<p style="margin:0;font-size:13px;color:#9B9380;">No one has a time-off allowance set.</p>`;

  const list = (from: string, to: string, empty: string) => {
    const items = rows.filter((r: any) => dOnly(r.start_at) <= to && dOnly(r.end_at) >= from)
      .sort((a: any, b: any) => dOnly(a.start_at).localeCompare(dOnly(b.start_at)) || (rank(byId[a.user_id]) - rank(byId[b.user_id])));
    if (!items.length) return { html: `<p style="margin:0;font-family:${F};font-size:13px;color:#9B9380;">${empty}</p>`, text: empty + "\n" };
    let h = TABLE, t = "";
    for (const r of items) {
      const [lab, col] = STATUS[r.status] || [r.status, "#6B6B6B"];
      const reason = r.reason ? ` <span style="color:#9B9380;">&middot; ${esc(r.reason)}</span>` : "";
      h += "<tr>" + td(`<span style="font-weight:600;color:#001A4A;">${esc(name(byId[r.user_id]))}</span>`) + td(esc(when(r)) + reason)
        + td(hd(Number(r.total_hours) || 0), "right") + td(`<span style="font-size:11px;font-weight:600;color:${col};">${lab}</span>`, "right", "padding-left:12px;") + "</tr>";
      t += `${name(byId[r.user_id])}: ${when(r)}${r.reason ? " (" + r.reason + ")" : ""}, ${hd(Number(r.total_hours) || 0)}, ${lab}\n`;
    }
    return { html: h + "</table>", text: t };
  };
  const up = list(upFrom, upTo, `Nothing on file for ${MONTH[month - 1]} or ${nextMonthName}.`);
  const taken = list(lastFrom, lastTo, `No time off in ${lastMonthName}.`);

  // Untracked roles: days logged this year, for visibility.
  let agRows = "", agText = "";
  for (const p of people) {
    if ((Number(p.time_off_days) || 0) > 0) continue;
    const logged = rows.filter((r: any) => r.user_id === p.id && (r.status === "noted" || r.status === "approved") && +dOnly(r.start_at).slice(0, 4) === year)
      .reduce((s: number, r: any) => s + (Number(r.total_hours) || 0), 0);
    agRows += "<tr>" + td(`<span style="font-weight:600;color:#001A4A;">${esc(name(p))}</span>`) + td(logged ? hd(logged) : `<span style="color:#9B9380;">none logged</span>`, "right") + "</tr>";
    agText += `${name(p)}: ${logged ? hd(logged) : "none logged"}\n`;
  }

  const asOfLabel = `${MONTH[month - 1]} ${+asOf.slice(8, 10)}, ${year}`;
  const body = `
    <p style="margin:0 0 8px;">
      <span style="display:block;font-size:20px;font-weight:600;color:#001A4A;">Time Off Summary</span>
      <span style="display:block;font-size:13px;color:#7A6A48;margin-top:4px;">Balances as of ${asOfLabel}</span>
    </p>`
    + section(`Balances, ${year}`) + balHtml
    + section(`Coming up: ${MONTH[month - 1]} and ${nextMonthName}`) + up.html
    + section(`Taken in ${lastMonthName}`) + taken.html
    + (agRows ? section("Sales agents (not tracked, for visibility)") + TABLE + "<tr>" + th("Person") + th("Logged this year", "right") + "</tr>" + agRows + "</table>" : "")
    + `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;"><tr><td bgcolor="#001A4A" style="background-color:#001A4A;border-radius:6px;">
<a href="${APP_ORIGIN}/#timeoff" style="display:block;padding:12px 22px;font-family:${F};font-size:13px;font-weight:600;color:#FFFFFF;text-decoration:none;">Open Time Off</a></td></tr></table>`;
  const text = `Time Off Summary\nBalances as of ${asOfLabel}\n\nBALANCES, ${year}\n${balText}\nCOMING UP\n${up.text}\nTAKEN IN ${lastMonthName.toUpperCase()}\n${taken.text}`
    + (agText ? `\nSALES AGENTS (logged this year)\n${agText}` : "") + `\nOpen Time Off: ${APP_ORIGIN}/#timeoff\n`;
  return { subject: `Time Off Summary - ${asOfLabel}`, html: shellHtml(body), text, periodKey: asOf.slice(0, 7) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const action = body?.action;
  try {
    const sb = serviceClient();
    if (!sb) return json({ error: "Server auth not configured." }, 500);
    if (!isCron(req) && !(await isAdmin(req, sb))) return json({ error: "Not authorized." }, 401);

    // as_of lets a test render a specific date (e.g. the next 1st); defaults to today in Central.
    const asOf = typeof body?.as_of === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.as_of) ? body.as_of : todayCentral();

    if (action === "preview") return json({ ok: true, ...(await buildEmail(sb, asOf)) });

    if (action === "send_test") {
      const to = (Array.isArray(body?.to) ? body.to : []).filter((e: unknown) => typeof e === "string" && /@themorshedgroup\.com$/i.test(e as string));
      if (!to.length) return json({ error: "send_test needs a 'to' list of @themorshedgroup.com addresses." }, 400);
      const email = await buildEmail(sb, asOf);
      await sendGmail(to, "[TEST] " + email.subject, email.html, email.text, await gmailToken());
      return json({ ok: true, sent: to });
    }

    if (action === "send_monthly") {
      const email = await buildEmail(sb, asOf);
      const { data: done } = await sb.from("time_off_summary_log").select("period_key").eq("period_key", email.periodKey).maybeSingle();
      if (done) return json({ ok: true, skipped: "already_sent", periodKey: email.periodKey });
      const token = await gmailToken();
      const failures: string[] = [];
      let sent = 0;
      for (const r of RECIPIENTS) {
        try { await sendGmail([r], email.subject, email.html, email.text, token); sent++; }
        catch (e) { failures.push(`${r}: ${String((e as any)?.message || e)}`); }
      }
      if (!sent) return json({ error: "All sends failed.", failures }, 500);
      await sb.from("time_off_summary_log").insert({ period_key: email.periodKey, recipients: sent });
      return json({ ok: true, sent, failures, periodKey: email.periodKey });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
