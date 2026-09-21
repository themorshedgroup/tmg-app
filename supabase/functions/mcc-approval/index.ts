// mcc-approval — Market Comparison Chart approval loop.
//
// POST {action:"send"}    : store a pending row, email the month's buyer + seller
//                           charts from operations@ with an Approve / Reject button.
// GET  ?token=..&a=approve: one tap from the email. No login: the token IS the
//                           authorisation, and it only ever reaches the recipient.
// POST {action:"status"}  : the Mac's scheduled task polls this, then places the
//                           files and calls {action:"placed"}.
//
// verify_jwt = false so the emailed link works from any mail client, so every
// POST must carry X-MCC-Secret. Gmail send uses the same service account and
// operations@ impersonation as tmg-notify / tmg-calendar-summary, duplicated
// here per the self-contained-bundle convention this repo already uses.
import { LOGO_SRC } from "./logo-asset.ts";

const NOTIFY_FROM_EMAIL = "operations@themorshedgroup.com";
const NOTIFY_FROM_NAME = "The Morshed Group Operations";
const FUNCTION_ORIGIN = "https://ipqoqhsnjubopybujetn.supabase.co/functions/v1/mcc-approval";
const BODY_FONT = "'Jost','Helvetica Neue',Arial,sans-serif";

// The five Drive destinations place_month.py writes to. IDs are stable because every
// step overwrites in place (shutil.copy / open(path,"wb")), which Drive treats as a new
// revision of the same file, not a new file. If a destination is ever deleted and
// recreated rather than overwritten, refresh the id here.
const DRIVE_LINKS: Array<{ label: string; url: string }> = [
  { label: "Buyer Market Comparison Charts", url: "https://drive.google.com/drive/folders/1qI0RvK8L6yDpsxSHowEhauOMc_akm00y" },
  { label: "Seller Market Comparison Charts", url: "https://drive.google.com/drive/folders/1TyFKZTy1WUdfRXlJ90gYsYeEgYqoYlzF" },
  { label: "Market Comparisons Chart (Buyer's Book)", url: "https://drive.google.com/file/d/1IKq3MA0oE7UTZdR3jrmUw1qq2GLFv6Sd/view" },
  { label: "Buyer Education Package, page 2", url: "https://drive.google.com/file/d/16YJYB2CZN4nSp08tkN1fBrrEzYGmZJlg/view" },
  { label: "Market Analysis, page 5", url: "https://drive.google.com/file/d/1hg3LoiAmpe9O5ScZoo1q8kTJpg0HVcQd/view" },
];

// ── small helpers ──
function b64url(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000; // chunked: String.fromCharCode blows the stack on a whole PDF
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64std(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s); // padded: RFC 2047 headers and MIME bodies both need the '='
}
function escapeHtml(s: string): string {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function newToken(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── Supabase (service role) ──
function db(path: string, init: RequestInit = {}): Promise<Response> {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("supabase_not_configured");
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key, Authorization: "Bearer " + key,
      "Content-Type": "application/json", ...(init.headers || {}),
    },
  });
}

// ── Gmail send-as, gmail.send impersonating operations@ ──
async function importPkcs8(pem: string): Promise<CryptoKey> {
  const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey("pkcs8", der.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}
let _saCache: { token: string; exp: number } | null = null;
async function gmailServiceAccountToken(): Promise<string> {
  const email = Deno.env.get("GCAL_SA_CLIENT_EMAIL");
  let key = Deno.env.get("GCAL_SA_PRIVATE_KEY") || "";
  if (!email || !key) throw new Error("gmail_sa_not_configured");
  key = key.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);
  if (_saCache && _saCache.exp > now + 60) return _saCache.token;
  const te = new TextEncoder();
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email, scope: "https://www.googleapis.com/auth/gmail.send",
    sub: NOTIFY_FROM_EMAIL, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  };
  const unsigned = b64url(te.encode(JSON.stringify(header))) + "." + b64url(te.encode(JSON.stringify(claim)));
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, await importPkcs8(key), te.encode(unsigned));
  const jwt = unsigned + "." + b64url(new Uint8Array(sig));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }).toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "Gmail service-account token failed");
  _saCache = { token: data.access_token, exp: now + (Number(data.expires_in) || 3600) };
  return data.access_token;
}

type Attach = { filename: string; b64: string };
// multipart/mixed wrapping a multipart/alternative — tmg-notify only ever needed
// alternative, so attachments are new here.
async function sendGmail(toList: string[], subject: string, html: string, text: string, files: Attach[]): Promise<string> {
  const token = await gmailServiceAccountToken();
  const mixed = "mcc_mix_" + crypto.randomUUID().replace(/-/g, "");
  const alt = "mcc_alt_" + crypto.randomUUID().replace(/-/g, "");
  const parts: string[] = [
    `From: ${NOTIFY_FROM_NAME} <${NOTIFY_FROM_EMAIL}>`,
    `To: ${toList.join(", ")}`,
    `Subject: =?UTF-8?B?${b64std(new TextEncoder().encode(subject))}?=`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    ``,
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    ``,
    `--${alt}`, `Content-Type: text/plain; charset="UTF-8"`, ``, text, ``,
    `--${alt}`, `Content-Type: text/html; charset="UTF-8"`, ``, html, ``,
    `--${alt}--`, ``,
  ];
  for (const f of files) {
    parts.push(
      `--${mixed}`,
      `Content-Type: application/pdf; name="${f.filename}"`,
      `Content-Disposition: attachment; filename="${f.filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      (f.b64.match(/.{1,76}/g) || []).join("\r\n"),
      ``,
    );
  }
  parts.push(`--${mixed}--`);
  const raw = b64url(new TextEncoder().encode(parts.join("\r\n")));
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ raw }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || ("Gmail send failed (HTTP " + res.status + ")"));
  return data?.id || "";
}

// ── Navy Edge shell, identical to tmg-calendar-summary ──
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

function actionButton(href: string, label: string, color: string, filled: boolean): string {
  const bg = filled ? color : "#FFFFFF";
  const fg = filled ? "#FFFFFF" : color;
  return `<td style="background-color:${bg};border:1px solid ${filled ? color : "#E4DFD4"};border-radius:2px;">
    <a href="${href}" style="display:block;padding:11px 30px;font-family:${BODY_FONT};font-size:11px;font-weight:600;letter-spacing:1.6px;text-transform:uppercase;color:${fg};text-decoration:none;white-space:nowrap;">${escapeHtml(label)}</a>
  </td>`;
}

function monthLabel(month: string): string {
  // Commercial rows are quarterly and carry 'YYYY-QN' in the same column.
  const q = /^(\d{4})-Q([1-4])$/.exec(month);
  if (q) return `Q${q[2]} ${q[1]}`;
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
}

// The commercial destinations. The chart itself gets a new file id every quarter
// (place_commercial.py copies a newly named file in), so the FOLDER is linked instead.
// The four guides are overwritten in place, so their ids are stable.
const COMMERCIAL_LINKS: Array<{ label: string; url: string }> = [
  { label: "Commercial Market Comparisons Chart (folder)", url: "https://drive.google.com/drive/folders/1qg0FH6YVFNZVecdtnlMk-PVeIEUBGUZV" },
  { label: "Commercial Buyer Guide, page 3", url: "https://drive.google.com/file/d/1jRw6W5w2M4wzDOpcS_JLZF4QCsfPbl1o/view" },
  { label: "Comparative Market Analysis - LRG, page 2", url: "https://drive.google.com/file/d/1dXpf_N0W95IPHMlw45ATXO-sBn2jkJKP/view" },
  { label: "Comparative Market Analysis - CLP, page 4", url: "https://drive.google.com/file/d/1SQPcq0BslWc52XevBOjzZZ-8myfQNxly/view" },
  { label: "Tenant Rep Guide, page 2", url: "https://drive.google.com/file/d/106k3LIKjG45CEvBkkeF06B7XHCrE_M5n/view" },
];

// Live roster, so a newly hired agent is included without editing this file.
// Repo convention for profiles.access (text[]) is overlap, never IN.
async function teamRecipients(): Promise<string[]> {
  const r = await db("profiles?select=email&status=eq.active&access=ov.%7Bagent,tc%7D");
  const rows = await r.json();
  if (!Array.isArray(rows)) return [];
  return [...new Set(rows.map((x: any) => String(x.email || "").trim().toLowerCase()).filter(Boolean))];
}

// ── handler ──
Deno.serve(async (req) => {
  const url = new URL(req.url);
  try {
    // One tap from the email.
    if (req.method === "GET") {
      const token = url.searchParams.get("token") || "";
      const a = url.searchParams.get("a") || "";
      if (!token || (a !== "approve" && a !== "reject")) return textPage("Link not valid", ["That approval link is missing or malformed."], 400);
      const look = await db(`tmg_mcc_approvals?token=eq.${encodeURIComponent(token)}&select=id,month,status`);
      const rows = await look.json();
      if (!Array.isArray(rows) || !rows.length) return textPage("Link not recognised", ["This approval link is not recognised.", "It may have been superseded by a newer one for the same month."], 404);
      const row = rows[0];
      if (row.status !== "pending") {
        return textPage(`${monthLabel(row.month)} was already ${row.status}`, ["Nothing further to do. This link has already been used."]);
      }
      const status = a === "approve" ? "approved" : "rejected";
      await db(`tmg_mcc_approvals?id=eq.${row.id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status, decided_at: new Date().toISOString() }),
      });
      return status === "approved"
        ? textPage(`${monthLabel(row.month)} approved`, [
            "The charts will be filed to Drive on the next check, usually within the hour.",
            "You will get a confirmation email listing every file that was touched.",
            "You can close this tab.",
          ])
        : textPage(`${monthLabel(row.month)} rejected`, [
            "Nothing will be filed.",
            "Open a Claude session to say what needs changing.",
          ]);
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    // Everything below is machine-to-machine and must prove it.
    const secret = Deno.env.get("MCC_SHARED_SECRET") || "";
    if (!secret || req.headers.get("X-MCC-Secret") !== secret) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = body.action || "";

    if (action === "status") {
      const month = String(body.month || "");
      const r = await db(`tmg_mcc_approvals?month=eq.${encodeURIComponent(month)}&select=id,month,kind,status,basis,created_at,decided_at,placed_at&order=created_at.desc&limit=1`);
      const rows = await r.json();
      return json({ ok: true, row: Array.isArray(rows) && rows.length ? rows[0] : null });
    }

    // Everything approved but not yet filed. The Mac poller's entry point.
    if (action === "pending_placement") {
      const r = await db("tmg_mcc_approvals?status=eq.approved&placed_at=is.null&select=id,month,kind,basis,decided_at&order=decided_at.asc");
      const rows = await r.json();
      return json({ ok: true, rows: Array.isArray(rows) ? rows : [] });
    }

    // Plain branded email, no attachments: the after-the-fact confirmation.
    if (action === "notify") {
      const to: string[] = Array.isArray(body.to) && body.to.length ? body.to : ["manager@themorshedgroup.com"];
      const subject = String(body.subject || "Market Comparison Chart");
      const heading = String(body.heading || subject);
      const sub = String(body.subheading || "");
      const lines: string[] = Array.isArray(body.lines) ? body.lines.map(String) : [];
      const bodyHtml = `
<span style="display:block;font-size:20px;font-weight:600;color:#001A4A;">${escapeHtml(heading)}</span>
${sub ? `<span style="display:block;font-size:13px;color:#7A6A48;margin-top:4px;">${escapeHtml(sub)}</span>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">
${lines.map((l) => `<tr><td style="padding:6px 0;border-bottom:1px solid #EDECE7;font-size:13px;color:#1A1A1A;">${escapeHtml(l)}</td></tr>`).join("")}
</table>`.trim();
      const msgId = await sendGmail(to, subject, shellHtml("Filed", bodyHtml), [heading, sub, "", ...lines].join("\n"), []);
      return json({ ok: true, gmail_message_id: msgId });
    }

    // Fires once Drive is actually up to date, so the body can claim it truthfully.
    if (action === "team_notify") {
      const month = String(body.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "bad_month" }, 400);
      const buyer = body.buyer as Attach, seller = body.seller as Attach;
      if (!buyer?.b64 || !seller?.b64) return json({ error: "both_pdfs_required" }, 400);
      const to: string[] = Array.isArray(body.to) && body.to.length ? body.to : await teamRecipients();
      if (!to.length) return json({ error: "no_recipients" }, 400);

      const label = monthLabel(month);
      const prior = monthLabel(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7));
      // Year comes from the month being archived, not the new one: a January chart
      // pushes the prior December into the PREVIOUS year's folder.
      const priorMonth = prior.split(" ")[0], year = prior.split(" ")[1];
      const rows = DRIVE_LINKS.map((l) =>
        `<tr><td style="padding:7px 0;border-bottom:1px solid #EDECE7;font-size:13.5px;color:#1A1A1A;"><a href="${l.url}" style="color:#001A4A;text-decoration:underline;">${escapeHtml(l.label)}</a></td></tr>`
      ).join("");
      const bodyHtml = `
<span style="display:block;font-size:20px;font-weight:600;color:#001A4A;">Residential Comparisons Chart</span>
<span style="display:block;font-size:13px;color:#7A6A48;margin-top:4px;">${escapeHtml(label)} &middot; buyer and seller</span>
<p style="margin:22px 0 0;">Hi team,</p>
<p style="margin:12px 0 0;">The ${escapeHtml(label)} Residential Market Comparison Chart is ready. Buyer and seller versions are attached.</p>
<p style="margin:18px 0 6px;font-size:13px;color:#7A6A48;letter-spacing:1.4px;text-transform:uppercase;font-weight:600;">Updated in Google Drive</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
<p style="margin:18px 0 0;">${escapeHtml(priorMonth)} has been archived into the ${escapeHtml(year)} folder in each location. Please pull from Drive going forward so we are all working from the same version.</p>
<p style="margin:18px 0 0;">Thanks!<br>TMG Operations</p>`.trim();
      const text = [
        `Residential Comparisons Chart - ${label} - buyer and seller`, "",
        "Hi team,", "",
        `The ${label} Residential Market Comparison Chart is ready. Buyer and seller versions are attached.`, "",
        "Updated in Google Drive:",
        ...DRIVE_LINKS.map((l) => `  ${l.label}: ${l.url}`), "",
        `${priorMonth} has been archived into the ${year} folder in each location. Please pull from Drive going forward so we are all working from the same version.`, "",
        "Thanks!", "TMG Operations",
      ].join("\n");

      const msgId = await sendGmail(to, `New: ${label} Residential Comparisons Chart`, shellHtml("Team update", bodyHtml), text, [buyer, seller]);
      return json({ ok: true, gmail_message_id: msgId, to });
    }

    // Commercial is quarterly, one PDF, and files to the Commercial shared drive.
    // Kept separate from "send" so the residential path cannot be disturbed.
    if (action === "send_commercial") {
      const quarter = String(body.quarter || "");
      if (!/^\d{4}-Q[1-4]$/.test(quarter)) return json({ error: "bad_quarter", hint: "expected YYYY-QN" }, 400);
      const to: string[] = Array.isArray(body.to) && body.to.length ? body.to : ["manager@themorshedgroup.com"];
      const facts: Array<{ label: string; value: string }> = Array.isArray(body.facts) ? body.facts : [];
      const chart = body.chart as Attach;
      if (!chart?.b64) return json({ error: "chart_required" }, 400);

      await db(`tmg_mcc_approvals?month=eq.${encodeURIComponent(quarter)}&status=eq.pending`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "rejected", decided_at: new Date().toISOString() }),
      });

      const token = newToken();
      const ins = await db("tmg_mcc_approvals", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify([{
          month: quarter, kind: "commercial", basis: "costar", token, status: "pending",
          summary: { facts }, buyer_filename: chart.filename, sent_to: to,
        }]),
      });
      const insRows = await ins.json();
      if (!ins.ok || !Array.isArray(insRows) || !insRows.length) return json({ error: "insert_failed", detail: insRows }, 500);

      const label = monthLabel(quarter);
      const factRows = facts.map((f) =>
        `<tr><td style="padding:7px 0;border-bottom:1px solid #EDECE7;font-size:13px;color:#7A6A48;white-space:nowrap;vertical-align:top;">${escapeHtml(f.label)}</td>
             <td style="padding:7px 0 7px 18px;border-bottom:1px solid #EDECE7;font-size:13px;color:#1A1A1A;">${escapeHtml(f.value)}</td></tr>`).join("");

      const bodyHtml = `
<span style="display:block;font-size:20px;font-weight:600;color:#001A4A;">Commercial Market Comparison Chart</span>
<span style="display:block;font-size:13px;color:#7A6A48;margin-top:4px;">${escapeHtml(label)} &middot; Austin, attached</span>
<p style="margin:22px 0 0;">CoStar Summary, Austin - TX (USA). Arrows compare each value with the previous quarter's chart.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">${factRows}</table>
<p style="margin:24px 0 10px;font-size:13px;color:#7A6A48;">Approving files the chart to the Commercial drive, archives last quarter, and swaps the chart page in the Commercial Buyer Guide, both Comparative Market Analyses and the Tenant Rep Guide. Nothing has been filed yet.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;border-collapse:separate;border-spacing:0;">
  <tr>
    ${actionButton(`${FUNCTION_ORIGIN}?token=${token}&a=approve`, "Approve & file", "#1B7F4D", true)}
    <td style="width:10px;">&nbsp;</td>
    ${actionButton(`${FUNCTION_ORIGIN}?token=${token}&a=reject`, "Reject", "#B3261E", false)}
  </tr>
</table>`.trim();

      const text = [
        `Commercial Market Comparison Chart - ${label} - Austin`, "",
        "CoStar Summary, Austin - TX (USA). Arrows compare each value with the previous quarter's chart.", "",
        ...facts.map((f) => `${f.label}: ${f.value}`), "",
        "Approving files the chart to the Commercial drive, archives last quarter, and swaps the",
        "chart page in the Commercial Buyer Guide, both Comparative Market Analyses and the Tenant Rep Guide.",
        "Nothing has been filed yet.", "",
        `Approve: ${FUNCTION_ORIGIN}?token=${token}&a=approve`,
        `Reject:  ${FUNCTION_ORIGIN}?token=${token}&a=reject`,
      ].join("\n");

      const msgId = await sendGmail(to, `Commercial MCC for approval: ${label}`, shellHtml("For approval", bodyHtml), text, [
        { filename: chart.filename || `${label} Commercial Market Comparison Chart.pdf`, b64: chart.b64 },
      ]);
      await db(`tmg_mcc_approvals?id=eq.${insRows[0].id}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ gmail_message_id: msgId }),
      });
      return json({ ok: true, id: insRows[0].id, gmail_message_id: msgId, to });
    }

    // Commercial twin of team_notify. One PDF, quarterly, five different destinations.
    if (action === "team_notify_commercial") {
      const quarter = String(body.quarter || "");
      if (!/^\d{4}-Q[1-4]$/.test(quarter)) return json({ error: "bad_quarter", hint: "expected YYYY-QN" }, 400);
      const chart = body.chart as Attach;
      if (!chart?.b64) return json({ error: "chart_required" }, 400);
      const to: string[] = Array.isArray(body.to) && body.to.length ? body.to : await teamRecipients();
      if (!to.length) return json({ error: "no_recipients" }, 400);

      const label = monthLabel(quarter);                       // "Q3 2026"
      const qn = Number(quarter.slice(6)), yr = Number(quarter.slice(0, 4));
      const prior = qn === 1 ? `Q4 ${yr - 1}` : `Q${qn - 1} ${yr}`;
      const rows = COMMERCIAL_LINKS.map((l) =>
        `<tr><td style="padding:7px 0;border-bottom:1px solid #EDECE7;font-size:13.5px;color:#1A1A1A;"><a href="${l.url}" style="color:#001A4A;text-decoration:underline;">${escapeHtml(l.label)}</a></td></tr>`
      ).join("");

      const bodyHtml = `
<span style="display:block;font-size:20px;font-weight:600;color:#001A4A;">Commercial Comparisons Chart</span>
<span style="display:block;font-size:13px;color:#7A6A48;margin-top:4px;">${escapeHtml(label)} &middot; Austin</span>
<p style="margin:22px 0 0;">Hi team,</p>
<p style="margin:12px 0 0;">The ${escapeHtml(label)} Austin Commercial Market Comparison Chart is ready. It is attached, and covers office, industrial, retail and multifamily.</p>
<p style="margin:18px 0 6px;font-size:13px;color:#7A6A48;letter-spacing:1.4px;text-transform:uppercase;font-weight:600;">Updated in Google Drive</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows}</table>
<p style="margin:18px 0 0;">${escapeHtml(prior)} has been moved into the Archive folder. Please pull from Drive going forward so we are all working from the same version.</p>
<p style="margin:18px 0 0;">Thanks!<br>TMG Operations</p>`.trim();

      const text = [
        `Commercial Comparisons Chart - ${label} - Austin`, "",
        "Hi team,", "",
        `The ${label} Austin Commercial Market Comparison Chart is ready. It is attached, and covers office, industrial, retail and multifamily.`, "",
        "Updated in Google Drive:",
        ...COMMERCIAL_LINKS.map((l) => `  ${l.label}: ${l.url}`), "",
        `${prior} has been moved into the Archive folder. Please pull from Drive going forward so we are all working from the same version.`, "",
        "Thanks!", "TMG Operations",
      ].join("\n");

      const msgId = await sendGmail(to, `New: ${label} Commercial Comparisons Chart`, shellHtml("Team update", bodyHtml), text, [chart]);
      return json({ ok: true, gmail_message_id: msgId, to });
    }

    if (action === "placed") {
      const id = String(body.id || "");
      await db(`tmg_mcc_approvals?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ placed_at: new Date().toISOString() }),
      });
      return json({ ok: true });
    }

    if (action === "send") {
      const month = String(body.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: "bad_month" }, 400);
      const basis = body.basis === "unlock_fallback" ? "unlock_fallback" : "austin_title";
      const to: string[] = Array.isArray(body.to) && body.to.length ? body.to : ["manager@themorshedgroup.com"];
      const facts: Array<{ label: string; value: string }> = Array.isArray(body.facts) ? body.facts : [];
      const buyer = body.buyer as Attach, seller = body.seller as Attach;
      if (!buyer?.b64 || !seller?.b64) return json({ error: "both_pdfs_required" }, 400);

      // Supersede any earlier pending row for this month so the unique index stays happy.
      await db(`tmg_mcc_approvals?month=eq.${encodeURIComponent(month)}&status=eq.pending`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ status: "rejected", decided_at: new Date().toISOString() }),
      });

      const token = newToken();
      const ins = await db("tmg_mcc_approvals", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify([{
          month, basis, token, status: "pending",
          summary: { facts }, buyer_filename: buyer.filename, seller_filename: seller.filename, sent_to: to,
        }]),
      });
      const insRows = await ins.json();
      if (!ins.ok || !Array.isArray(insRows) || !insRows.length) return json({ error: "insert_failed", detail: insRows }, 500);
      const rowId = insRows[0].id;

      const label = monthLabel(month);
      const basisLine = basis === "austin_title"
        ? "Austin Title, trailing twelve months, both columns."
        : "Unlock MLS fallback, calendar month, both columns. Austin Title skipped this month.";
      const factRows = facts.map((f) =>
        `<tr><td style="padding:7px 0;border-bottom:1px solid #EDECE7;font-size:13px;color:#7A6A48;white-space:nowrap;">${escapeHtml(f.label)}</td>
             <td style="padding:7px 0 7px 18px;border-bottom:1px solid #EDECE7;font-size:13px;color:#1A1A1A;">${escapeHtml(f.value)}</td></tr>`).join("");

      const bodyHtml = `
<span style="display:block;font-size:20px;font-weight:600;color:#001A4A;">Market Comparison Chart</span>
<span style="display:block;font-size:13px;color:#7A6A48;margin-top:4px;">${escapeHtml(label)} &middot; buyer and seller, attached</span>
<p style="margin:22px 0 0;">${escapeHtml(basisLine)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 0;">${factRows}</table>
<p style="margin:24px 0 10px;font-size:13px;color:#7A6A48;">Approving files both charts to Drive, archives last month, refreshes the workbook, and swaps the chart page in the Buyer Education Package and Market Analysis. Nothing has been filed yet.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;border-collapse:separate;border-spacing:0;">
  <tr>
    ${actionButton(`${FUNCTION_ORIGIN}?token=${token}&a=approve`, "Approve & file", "#1B7F4D", true)}
    <td style="width:10px;">&nbsp;</td>
    ${actionButton(`${FUNCTION_ORIGIN}?token=${token}&a=reject`, "Reject", "#B3261E", false)}
  </tr>
</table>`.trim();

      const text = [
        `Market Comparison Chart — ${label}`, "", basisLine, "",
        ...facts.map((f) => `${f.label}: ${f.value}`), "",
        "Approving files both charts to Drive, archives last month, refreshes the workbook,",
        "and swaps the chart page in the Buyer Education Package and Market Analysis.",
        "Nothing has been filed yet.", "",
        `Approve: ${FUNCTION_ORIGIN}?token=${token}&a=approve`,
        `Reject:  ${FUNCTION_ORIGIN}?token=${token}&a=reject`,
      ].join("\n");

      const msgId = await sendGmail(to, `MCC for approval: ${label}`, shellHtml("For approval", bodyHtml), text, [
        { filename: buyer.filename || `${label} Buyer Comparison Chart.pdf`, b64: buyer.b64 },
        { filename: seller.filename || `${label} Seller Comparison Chart.pdf`, b64: seller.b64 },
      ]);
      await db(`tmg_mcc_approvals?id=eq.${rowId}`, {
        method: "PATCH", headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ gmail_message_id: msgId }),
      });
      return json({ ok: true, id: rowId, month, sent_to: to, gmail_message_id: msgId });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    return json({ error: String((e as Error)?.message || e) }, 500);
  }
});

// The Supabase functions gateway rewrites responses to Content-Type: text/plain
// under a "default-src 'none'; sandbox" CSP, so an HTML page here renders as raw
// source in the browser. Plain text is what actually reaches the reader.
function textPage(heading: string, lines: string[], status = 200): Response {
  const body = [heading, "=".repeat(heading.length), "", ...lines, "", "The Morshed Group"].join("\n");
  return new Response(body + "\n", { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
