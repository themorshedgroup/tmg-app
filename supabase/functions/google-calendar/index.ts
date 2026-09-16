// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: google-calendar
// Reads/writes a user's Google Calendar + Google Tasks server-side so events
// show in the TMG calendar popout and TMG tasks can auto-sync to Google Tasks.
// Mirrors the `ai-chat` function's auth gate.
//
// Deploy: Supabase Dashboard → Edge Functions → function `google-calendar`
//   Paste this whole file, then click Deploy.
//
// Secrets required (Dashboard → Edge Functions → Manage secrets):
//   GOOGLE_CLIENT_SECRET = <that client's secret>
//   (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// Prereqs: Google Calendar API + Google Tasks API + Gmail API enabled in the
// Cloud project; the OAuth consent screen includes `.../auth/calendar.events`,
// `.../auth/tasks`, and `.../auth/gmail.readonly`; the app requests all three
// at "Connect"/"Reconnect" with access_type=offline so a refresh token is
// issued (see supabase.js). gmail.readonly is a sensitive (not restricted)
// scope — it may need to show up on the OAuth consent screen's scope list
// before Google will grant it; if `connect` succeeds but gmail_* calls come
// back invalid_scope, that's almost always the fix.
//
// POST actions:
//   { action: 'connect', refresh_token }            → store the caller's refresh token
//   { action: 'calendars' }                         → list the account's calendars (id, name, color, accessRole)
//   { action: 'list', timeMin, timeMax,             → list events. With calendarIds, pulls from
//             calendarIds?: string[] }                 several calendars and tags each event with
//                                                       its calendarId + color; without, primary only.
//   { action: 'create', calendarId, event }         → create an event (sends Google invites if attendees)
//   { action: 'update', calendarId, eventId, event }→ patch an event
//   { action: 'delete', calendarId, eventId }       → delete an event
//   { action: 'rsvp', calendarId, eventId, status } → set ONLY the caller's own RSVP
//   { action: 'create-task', task: { title, notes?, due? } } → add a task to the
//             caller's default Google Tasks list (used by TMG's task auto-sync)
//   (event = Google resource: { summary, location, description, start, end, attendees, recurrence })
//   NOTE: `list` also returns hangoutLink, attendeesDetail[], and myResponse per event.
//
//   ── My Tasks email mailbox (TMG-Toolbar-and-Email-Brief_1.md Feature 2) ──
//   { action: 'gmail_threads', q?: string, maxResults?: number }
//             → recent Gmail threads (default: INBOX, newest first) with
//               {id, permalink, from, subject, snippet, date}. Read-only
//               (gmail.readonly) — never sends, archives, or modifies anything.
//   { action: 'gmail_thread', threadId }
//             → one thread's messages in full: {id, from, to, date, subject,
//               bodyText} per message, oldest first — for the task drawer's
//               Email tab reader.
//
//   ── Contact summary (the (i) on a Calls-tab row) ──
//   { action: 'contact_brief', contact_id }
//             → a few sentences to read before dialling. Returns PROSE ONLY.
//
//   ⚠ AUTH NOTE — read before touching this action. Every OTHER action in this
//   file reads the CALLER'S OWN mailbox through callerAccessToken() below, which
//   is why authorizeCaller()'s "any active profile" gate is sufficient for them.
//   `contact_brief` is the exception: it reads the OWNING AGENT's mailbox and
//   that agent's assigned TC's. So it carries its own predicate (the caller is
//   that agent, OR is that agent's assigned TC, OR holds admin/operations), a
//   per-person consent switch (public.brief_mailboxes), an hourly ceiling, and
//   an access log. Do NOT relax it to match the rest of the file, do NOT let any
//   client value name a mailbox or a Gmail query, and never return a subject,
//   snippet, address or thread id from it.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// The shared company Team Calendar. OOO/time-off events are written here by the
// service account (see serviceAccountToken) so approvals never depend on the
// approver having connected their personal Google Calendar.
const TEAM_CALENDAR_ID = "c_u17la9j1annqi72em9qs3e8v44@group.calendar.google.com";

// Service-role client (server-side only; bypasses RLS for token + profile lookups).
function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key);
}

// Verifies the caller's Supabase session and requires an ACTIVE TMG profile.
async function authorizeCaller(req: Request) {
  const sb = serviceClient();
  if (!sb) return { ok: false as const, status: 500, error: "Server auth not configured." };

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false as const, status: 401, error: "Sign in required." };

  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) return { ok: false as const, status: 401, error: "Invalid or expired session." };

  const { data: profile, error: pErr } = await sb
    .from("profiles").select("status").eq("id", user.id).single();
  if (pErr || !profile) return { ok: false as const, status: 403, error: "Account pending approval." };
  if (profile.status !== "active") return { ok: false as const, status: 403, error: "Account is not active." };

  return { ok: true as const, userId: user.id, sb };
}

// Exchange a stored refresh token for a fresh Google access token.
async function googleAccessToken(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    // Public OAuth client id (safe to embed) — removes the need for the GOOGLE_CLIENT_ID secret.
    client_id: "931478099859-9jifv0fl9v3s67oc7pa5ka6j61eeujfq.apps.googleusercontent.com",
    client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Failed to refresh Google token");
  }
  return data.access_token;
}

// ── Service-account access token for the shared Team Calendar ──────────────
// Lets the app write/read the company Team Calendar with its own identity, so a
// time-off approval can drop an OOO event regardless of whether the approver has
// connected their personal Google Calendar. The service account is granted
// "Make changes to events" on the Team Calendar directly (calendar sharing) —
// no domain-wide delegation needed. Secrets: GCAL_SA_CLIENT_EMAIL + GCAL_SA_PRIVATE_KEY.
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
  key = key.replace(/\\n/g, "\n"); // secret managers commonly store the PEM with escaped newlines

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
  // Domain-wide delegation: if a subject is configured, the service account acts AS
  // that internal Workspace user (who owns/can-edit the Team Calendar). This avoids
  // having to share the calendar externally with the service account (secondary
  // calendars block external editing by org policy). Requires the SA's client id to
  // be authorized for the calendar scope in Admin → API controls → Domain-wide delegation.
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

// Look up the caller's stored refresh token and mint a fresh access token.
// Returns either { token } or { err } where err is a ready-to-send {status, body}.
async function callerAccessToken(sb: any, userId: string): Promise<{ token?: string; err?: { status: number; body: unknown } }> {
  const { data: row, error: rErr } = await sb
    .from("google_tokens").select("refresh_token").eq("user_id", userId).maybeSingle();
  if (rErr) return { err: { status: 500, body: { error: rErr.message } } };
  if (!row?.refresh_token) return { err: { status: 412, body: { error: "needs_connect" } } };
  try {
    return { token: await googleAccessToken(row.refresh_token) };
  } catch (e) {
    // Refresh token revoked/expired → user must reconnect (re-sign-in).
    return { err: { status: 412, body: { error: "needs_connect", detail: String((e as any)?.message || e) } } };
  }
}

// ── Gmail helpers ────────────────────────────────────────────────────────
// Gmail message bodies are base64url (RFC 4648 §5), not plain base64.
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}
function gmailHeader(headers: any[], name: string): string {
  const h = (headers || []).find((x: any) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || "";
}
// Recursively walk a Gmail message payload for the first text/plain part,
// falling back to text/html with tags stripped (Gmail can send either, and
// multipart/alternative nests them under .parts).
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
// "#all" (not "#inbox") so the link still resolves once a thread is archived.
function gmailPermalink(threadId: string): string {
  return "https://mail.google.com/mail/u/0/#all/" + threadId;
}

// ── Contact summary: caps ────────────────────────────────────────────────
// Every one of these is a ceiling on somebody else's mail and somebody's money,
// so they live together where they can be read at a glance.
//
// SNIPPETS, NOT BODIES. gmail_thread above returns every message untruncated,
// and six of those at ctc-emails' 6000-char cap would be ~36,000 characters —
// against ai-chat's hard 48,000-char ceiling, which rejects with a 413 whose
// text tells the user to go and use Gemini. Shown to an agent who tapped (i),
// that is nonsense. Gmail's own snippet already carries the subject, the
// sender, the date and the opening line, which is what "what just happened"
// actually needs.
const CB_THREADS_PER_MAILBOX = 3;      // ≤3 per mailbox, so ≤6 threads a tap
const CB_SNIPPET_CHARS = 260;          // Gmail's snippet, clipped
const CB_MAX_CONTEXT_CHARS = 12000;    // hard slice before the model sees it
const CB_MAX_TOKENS = 340;             // a real brief is ~90; this is a ceiling
const CB_READS_PER_HOUR = 60;          // per viewer. Stops a scripted sweep.
// Zoho hands back ten emails per call and there is no per_page to raise it, so
// ten is the whole page. All of them go to the model: these are one line each,
// and the oldest of ten is still the thing that says "we have not emailed this
// contact since March".
const CB_ZOHO_EMAILS = 10;

// Mint a Google access token for an ARBITRARY user id.
//
// This is the ONLY arbitrary-user path in this file and it exists solely for
// contact_brief. Every other action must keep using callerAccessToken above —
// if you find yourself reaching for this one somewhere else, the authorization
// question has not been answered yet.
async function userAccessToken(sb: any, userId: string): Promise<string> {
  const { data: row, error } = await sb
    .from("google_tokens").select("refresh_token").eq("user_id", userId).maybeSingle();
  if (error) throw new Error("token_read_failed");
  if (!row?.refresh_token) throw new Error("needs_connect");
  try {
    return await googleAccessToken(row.refresh_token);
  } catch (_e) {
    throw new Error("needs_connect");
  }
}

const cbName = (p: any) =>
  [p?.first_name, p?.last_name].filter(Boolean).join(" ").trim() || p?.email || "a teammate";

// One mailbox's worth of context. Returns the threads it could read plus the
// reason it could not, which the sheet shows verbatim — a brief that quietly
// skipped half its sources is worse than one that says it did.
async function cbSearchMailbox(sb: any, person: any, role: string, contactEmail: string) {
  const out = { role, name: cbName(person), state: "searched", threads: 0, lines: [] as string[] };
  if (!person) { out.state = role === "tc" ? "no_tc_assigned" : "unknown"; return out; }
  if (person.status !== "active") { out.state = "not_active"; return out; }

  const { data: sw } = await sb.from("brief_mailboxes")
    .select("enabled").eq("user_id", person.id).maybeSingle();
  if (!sw || sw.enabled !== true) { out.state = "not_enabled"; return out; }

  let token: string;
  try { token = await userAccessToken(sb, person.id); }
  catch (_e) { out.state = "not_connected"; return out; }

  const e = contactEmail.replace(/[()"\\]/g, "");
  // cc: and bcc: are separate operators in Gmail — `to:` matches ONLY the To
  // header. A newsletter goes out with the whole list in BCC, so the July
  // newsletter was invisible here until bcc: was added. We are searching the
  // SENDER's own mailbox, which is the one copy where the Bcc header survives.
  const q = `(from:${e} OR to:${e} OR cc:${e} OR bcc:${e}) newer_than:365d -in:chats -in:drafts -in:spam -in:trash`;
  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads");
  listUrl.searchParams.set("maxResults", String(CB_THREADS_PER_MAILBOX));
  listUrl.searchParams.set("q", q);

  const lr = await fetch(listUrl.toString(), { headers: { Authorization: "Bearer " + token } });
  if (!lr.ok) {
    // 403 here is overwhelmingly "insufficient authentication scopes": this
    // person connected Google BEFORE gmail.readonly was added, so their refresh
    // token mints fine and only the Gmail call fails. That needs a Reconnect,
    // not a retry, and saying "couldn't search just now" would leave them
    // waiting forever for something that resolves itself never.
    out.state = lr.status === 403 ? "not_scoped" : "search_failed";
    return out;
  }
  const ld = await lr.json().catch(() => ({}));
  const ids: string[] = (ld.threads || []).map((t: any) => t.id).filter(Boolean).slice(0, CB_THREADS_PER_MAILBOX);

  const metas = await Promise.all(ids.map(async (id) => {
    const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads/" + encodeURIComponent(id));
    u.searchParams.set("format", "metadata");   // NEVER "full" in this action
    u.searchParams.append("metadataHeaders", "From");
    u.searchParams.append("metadataHeaders", "Subject");
    u.searchParams.append("metadataHeaders", "Date");
    const tr = await fetch(u.toString(), { headers: { Authorization: "Bearer " + token } });
    if (!tr.ok) return null;
    const td = await tr.json().catch(() => null);
    const msgs = td?.messages || [];
    const last = msgs[msgs.length - 1];
    if (!last) return null;
    const h = last.payload?.headers || [];
    const snip = String(last.snippet || td?.snippet || "").replace(/\s+/g, " ").slice(0, CB_SNIPPET_CHARS);
    return `- [${out.name}'s mailbox] ${gmailHeader(h, "Date")} | ${gmailHeader(h, "Subject") || "(no subject)"} | from ${gmailHeader(h, "From")} | ${msgs.length} message(s) | ${snip}`;
  }));
  out.lines = metas.filter(Boolean) as string[];
  out.threads = out.lines.length;
  return out;
}

const CONTACT_BRIEF_SYSTEM = [
  "You write a one-glance brief an estate agent reads in the five seconds before they dial.",
  "",
  "OUTPUT — exactly this shape, nothing before it and nothing after it:",
  "",
  "DEALS",
  "- <bullet>",
  "TOUCH",
  "- <bullet>",
  "EMAIL",
  "- <bullet>",
  "",
  "FORMAT RULES:",
  "- All three headings always appear, in that order, spelled exactly as shown, alone on their line.",
  "- Each heading is followed by one to three bullets. Every bullet starts with '- '.",
  "- A bullet is ONE short clause, under 18 words. No headings of your own, no paragraphs.",
  "- A section with nothing to report gets exactly one bullet: '- Nothing on file.'",
  "",
  "WHAT BELONGS IN EACH SECTION:",
  "- DEALS: open deals and their stage. Amount and closing date only if you were given them.",
  "- TOUCH: the single most recent thing under DONE, with its date. ANY task type counts —",
  "  a note, an email task and a text are touches exactly as much as a call is. Take the newest one",
  "  and say what it was and when. NEVER put a SCHEDULED item here as though it had happened.",
  "  Only when DONE is empty do you say there is nothing logged, and then you may add what is booked.",
  "- EMAIL: what the most recent email was actually about, in the plainest words available.",
  "  If ANY mail is listed on the Zoho contact record, this section is never 'Nothing on file' —",
  "  say what the newest one was and give its date, even when that date is years ago. Old mail is",
  "  a fact worth knowing; silence reads as 'never emailed', which is a different and worse answer.",
  "",
  "RULES:",
  "- Never invent a name, a number, a date, a price or an event you were not given.",
  "- EVERY date you write must appear verbatim in the data above. Never approximate a date, never",
  "  widen one into a season or a year, and never infer a range. If you are unsure, leave the date out.",
  "- Do not repeat the contact's own name.",
  "- Do not mention email addresses, thread subjects verbatim, or whose mailbox anything came from.",
  "- The two email sections can describe the SAME message. Count an exchange once.",
  "- A newsletter, market update or monthly-insights mailer is a mass send, not a conversation.",
  "  Worth one bullet so the agent knows it goes out ('gets the monthly market email'), never",
  "  worded as if the agent and the contact were in touch.",
  "- Do not give advice, do not suggest what to say on the call, and do not editorialise.",
].join("\n");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const auth = await authorizeCaller(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    const sb = auth.sb;

    const body = await req.json().catch(() => ({}));
    const action = body.action;

    // ── Store the caller's Google refresh token (called once after sign-in) ──
    if (action === "connect") {
      const refresh = body.refresh_token;
      if (!refresh) return json({ error: "Missing refresh_token." }, 400);
      const { error } = await sb.from("google_tokens").upsert({
        user_id: auth.userId, refresh_token: refresh, updated_at: new Date().toISOString(),
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true }, 200);
    }

    // ── Diagnostic: what scope did Google actually grant on the caller's stored
    // token? (Distinguishes "Google silently dropped calendar/tasks scope" from
    // other failure modes — see project_tmg_team_calendar_service_account memory.)
    if (action === "token-diag") {
      const { data: row } = await sb
        .from("google_tokens").select("refresh_token, updated_at").eq("user_id", auth.userId).maybeSingle();
      if (!row?.refresh_token) return json({ error: "needs_connect" }, 412);
      const body2 = new URLSearchParams({
        client_id: "931478099859-9jifv0fl9v3s67oc7pa5ka6j61eeujfq.apps.googleusercontent.com",
        client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET") || "",
        refresh_token: row.refresh_token,
        grant_type: "refresh_token",
      });
      const res2 = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body2.toString(),
      });
      const data2 = await res2.json();
      return json({
        tokenUpdatedAt: row.updated_at,
        exchangeOk: res2.ok,
        grantedScope: data2.scope || null,
        error: data2.error || null,
        errorDescription: data2.error_description || null,
      }, 200);
    }

    // ── List the calendars on the caller's account (id, name, color) ──
    if (action === "calendars") {
      const at = await callerAccessToken(sb, auth.userId);
      if (at.err) return json(at.err.body, at.err.status);

      const clRes = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { Authorization: "Bearer " + at.token },
      });
      const clData = await clRes.json();
      if (!clRes.ok) return json({ error: clData?.error?.message || "Calendar API error" }, clRes.status);

      const calendars = (clData.items || []).map((c: any) => ({
        id: c.id,
        summary: c.summaryOverride || c.summary || c.id,
        color: c.backgroundColor || null,
        primary: !!c.primary,
        accessRole: c.accessRole || null,
        canWrite: c.accessRole === "owner" || c.accessRole === "writer",
      }));
      return json({ calendars }, 200);
    }

    // ── List events. With calendarIds → multi-calendar + color; without → primary only ──
    if (action === "list") {
      const at = await callerAccessToken(sb, auth.userId);
      if (at.err) return json(at.err.body, at.err.status);
      const accessToken = at.token!;

      const reqIds: string[] = Array.isArray(body.calendarIds) && body.calendarIds.length
        ? body.calendarIds.filter((x: unknown) => typeof x === "string" && x)
        : ["primary"];

      // Resolve per-calendar colors (best-effort) when more than the bare primary is requested.
      const colorById: Record<string, string> = {};
      const needColors = reqIds.length > 1 || reqIds[0] !== "primary";
      if (needColors) {
        try {
          const clRes = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
            headers: { Authorization: "Bearer " + accessToken },
          });
          const clData = await clRes.json();
          if (clRes.ok) (clData.items || []).forEach((c: any) => { if (c.backgroundColor) colorById[c.id] = c.backgroundColor; });
        } catch (_) { /* events still return, just without per-calendar color */ }
      }

      const fetchOne = async (calId: string) => {
        const url = new URL("https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) + "/events");
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("maxResults", "250");
        if (body.timeMin) url.searchParams.set("timeMin", body.timeMin);
        if (body.timeMax) url.searchParams.set("timeMax", body.timeMax);
        const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + accessToken } });
        const d = await r.json();
        if (!r.ok) return [];  // skip a calendar that errors (e.g. lost access) rather than fail the whole request
        return (d.items || []).map((e: any) => {
          const atts = Array.isArray(e.attendees) ? e.attendees : [];
          return {
            id: e.id,
            title: e.summary || "(no title)",
            start: e.start?.dateTime || e.start?.date || null,
            end: e.end?.dateTime || e.end?.date || null,
            allDay: !e.start?.dateTime,
            colorId: e.colorId || null,
            calendarId: calId,
            color: colorById[calId] || null,
            location: e.location || null,
            description: e.description || null,
            hangoutLink: e.hangoutLink || null,
            attendees: atts.map((a: any) => a.email).filter(Boolean),
            // Rich attendee data for the brief: name, RSVP state, and who is "me".
            attendeesDetail: atts.map((a: any) => ({
              email: a.email || null,
              name: a.displayName || null,
              responseStatus: a.responseStatus || null,
              self: !!a.self,
              organizer: !!a.organizer,
            })),
            // The caller's own current RSVP for this event (null if not an attendee).
            myResponse: (atts.find((a: any) => a.self) || {}).responseStatus || null,
            recurrence: e.recurrence || null,
            recurringEventId: e.recurringEventId || null,
          };
        });
      };

      const results = await Promise.all(reqIds.map(fetchOne));
      return json({ events: results.flat() }, 200);
    }

    // ── Create or update an event (write). sendUpdates=all → Google emails any attendees ──
    if (action === "create" || action === "update") {
      const at = await callerAccessToken(sb, auth.userId);
      if (at.err) return json(at.err.body, at.err.status);

      const calId = typeof body.calendarId === "string" && body.calendarId ? body.calendarId : "primary";
      const ev = (body.event && typeof body.event === "object") ? body.event : null;
      if (!ev) return json({ error: "Missing event payload." }, 400);
      const isUpdate = action === "update";
      if (isUpdate && !body.eventId) return json({ error: "Missing eventId for update." }, 400);

      const url = new URL(
        "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) + "/events" +
        (isUpdate ? "/" + encodeURIComponent(body.eventId) : "")
      );
      url.searchParams.set("sendUpdates", "all");

      const r = await fetch(url.toString(), {
        method: isUpdate ? "PATCH" : "POST",
        headers: { Authorization: "Bearer " + at.token, "Content-Type": "application/json" },
        body: JSON.stringify(ev),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error?.message || "Calendar write failed." }, r.status);
      return json({ ok: true, id: d.id }, 200);
    }

    // ── Delete an event ──
    if (action === "delete") {
      const at = await callerAccessToken(sb, auth.userId);
      if (at.err) return json(at.err.body, at.err.status);

      const calId = typeof body.calendarId === "string" && body.calendarId ? body.calendarId : "primary";
      if (!body.eventId) return json({ error: "Missing eventId." }, 400);

      const url = new URL(
        "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(calId) +
        "/events/" + encodeURIComponent(body.eventId)
      );
      url.searchParams.set("sendUpdates", "all");

      const r = await fetch(url.toString(), { method: "DELETE", headers: { Authorization: "Bearer " + at.token } });
      // 410 Gone = already deleted; treat as success.
      if (!r.ok && r.status !== 410) {
        const d = await r.json().catch(() => ({}));
        return json({ error: d?.error?.message || "Delete failed." }, r.status);
      }
      return json({ ok: true }, 200);
    }

    // ── Create a task in the caller's default Google Tasks list ──
    if (action === "create-task") {
      const at = await callerAccessToken(sb, auth.userId);
      if (at.err) return json(at.err.body, at.err.status);

      const t = (body.task && typeof body.task === "object") ? body.task : null;
      if (!t || !t.title) return json({ error: "Missing task title." }, 400);

      const payload: Record<string, unknown> = { title: t.title };
      if (t.notes) payload.notes = String(t.notes);
      if (t.due) payload.due = new Date(t.due).toISOString();

      const r = await fetch("https://www.googleapis.com/tasks/v1/lists/@default/tasks", {
        method: "POST",
        headers: { Authorization: "Bearer " + at.token, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error?.message || "Google Tasks create failed." }, r.status);
      return json({ ok: true, id: d.id }, 200);
    }

    // ── RSVP: set only the caller's own response on an event (Yes / No / Maybe) ──
    if (action === "rsvp") {
      const at = await callerAccessToken(sb, auth.userId);
      if (at.err) return json(at.err.body, at.err.status);

      const calId = typeof body.calendarId === "string" && body.calendarId ? body.calendarId : "primary";
      const eventId = body.eventId;
      const status = body.status; // accepted | declined | tentative | needsAction
      if (!eventId || !["accepted", "declined", "tentative", "needsAction"].includes(status))
        return json({ error: "Missing eventId or invalid status." }, 400);

      const evUrl = "https://www.googleapis.com/calendar/v3/calendars/" +
        encodeURIComponent(calId) + "/events/" + encodeURIComponent(eventId);

      // Fetch the event, flip ONLY the self attendee, then PATCH the full attendees
      // list back (so no one else's response is clobbered).
      const gr = await fetch(evUrl, { headers: { Authorization: "Bearer " + at.token } });
      const gd = await gr.json().catch(() => ({}));
      if (!gr.ok) return json({ error: gd?.error?.message || "Could not load the event." }, gr.status);

      const attendees = Array.isArray(gd.attendees) ? gd.attendees : [];
      const me = attendees.find((a: any) => a.self);
      if (!me) return json({ error: "You are not an attendee of this event." }, 400);
      me.responseStatus = status;

      const pr = await fetch(evUrl + "?sendUpdates=all", {
        method: "PATCH",
        headers: { Authorization: "Bearer " + at.token, "Content-Type": "application/json" },
        body: JSON.stringify({ attendees }),
      });
      const pd = await pr.json().catch(() => ({}));
      if (!pr.ok) return json({ error: pd?.error?.message || "RSVP failed." }, pr.status);
      return json({ ok: true, status }, 200);
    }

    // ── Diagnostic: list every calendar the service account can actually see ──
    // Used to confirm the Team Calendar was shared with the SA and to read back its
    // exact, full calendar id. Safe/read-only; gated to active TMG users like everything else.
    if (action === "team-diag") {
      let saToken: string;
      try { saToken = await serviceAccountToken(); }
      catch (e) { return json({ error: String((e as any)?.message || e) }, 500); }
      const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
        headers: { Authorization: "Bearer " + saToken },
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error?.message || "calendarList failed", status: r.status }, r.status);
      return json({
        configuredTeamId: TEAM_CALENDAR_ID,
        visible: (d.items || []).map((c: any) => ({ id: c.id, summary: c.summary, accessRole: c.accessRole })),
      }, 200);
    }

    // ── Team Calendar ops via the shared service account (no personal connect needed) ──
    // The caller is still gated to an active TMG profile above; the Google write/read
    // itself uses the service account, so it works even if the caller never connected
    // their own Google Calendar. The target is always the company Team Calendar.
    if (action === "team-event-create" || action === "team-event-update" ||
        action === "team-event-delete" || action === "team-events-list") {
      let saToken: string;
      try {
        saToken = await serviceAccountToken();
      } catch (e) {
        const msg = String((e as any)?.message || e);
        return json({ error: msg === "team_calendar_not_configured" ? "team_calendar_not_configured" : "Team Calendar auth failed." }, msg === "team_calendar_not_configured" ? 501 : 502);
      }
      const encId = encodeURIComponent(TEAM_CALENDAR_ID);
      const evBase = "https://www.googleapis.com/calendar/v3/calendars/" + encId + "/events";

      // Diagnostic: what calendars can the service account actually see? Helps confirm the
      // Team Calendar was shared with it and that TEAM_CALENDAR_ID matches.
      if (action === "team-events-list" && body.diag === "calendars") {
        const r = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList", { headers: { Authorization: "Bearer " + saToken } });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: d?.error?.message || "calendarList failed.", status: r.status }, r.status);
        return json({ target: TEAM_CALENDAR_ID, visible: (d.items || []).map((c: any) => ({ id: c.id, summary: c.summary, accessRole: c.accessRole })) }, 200);
      }

      if (action === "team-events-list") {
        const url = new URL(evBase);
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("maxResults", "250");
        if (body.timeMin) url.searchParams.set("timeMin", body.timeMin);
        if (body.timeMax) url.searchParams.set("timeMax", body.timeMax);
        const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + saToken } });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return json({ error: d?.error?.message || "Team Calendar read failed." }, r.status);
        const events = (d.items || []).map((e: any) => ({
          id: e.id,
          title: e.summary || "(no title)",
          start: e.start?.dateTime || e.start?.date || null,
          end: e.end?.dateTime || e.end?.date || null,
          allDay: !e.start?.dateTime,
          calendarId: TEAM_CALENDAR_ID,
          colorId: e.colorId || null,
          color: null,
        }));
        return json({ events }, 200);
      }

      if (action === "team-event-delete") {
        if (!body.eventId) return json({ error: "Missing eventId." }, 400);
        const r = await fetch(evBase + "/" + encodeURIComponent(body.eventId), {
          method: "DELETE", headers: { Authorization: "Bearer " + saToken },
        });
        if (!r.ok && r.status !== 410) { // 410 Gone = already deleted → treat as success
          const d = await r.json().catch(() => ({}));
          return json({ error: d?.error?.message || "Team Calendar delete failed." }, r.status);
        }
        return json({ ok: true }, 200);
      }

      // create / update
      const ev = (body.event && typeof body.event === "object") ? body.event : null;
      if (!ev) return json({ error: "Missing event payload." }, 400);
      const isUpd = action === "team-event-update";
      if (isUpd && !body.eventId) return json({ error: "Missing eventId for update." }, 400);
      const r = await fetch(evBase + (isUpd ? "/" + encodeURIComponent(body.eventId) : ""), {
        method: isUpd ? "PATCH" : "POST",
        headers: { Authorization: "Bearer " + saToken, "Content-Type": "application/json" },
        body: JSON.stringify(ev),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error?.message || "Team Calendar write failed." }, r.status);
      return json({ ok: true, id: d.id }, 200);
    }

    // ── Mailbox: recent threads (My Tasks email icon → mailbox pop-out) ──
    // Read-only — gmail.readonly can't send/archive/modify, so there's no risk
    // of this action touching the caller's real inbox state [brief §2.6].
    if (action === "gmail_threads") {
      const at = await callerAccessToken(sb, auth.userId);
      if (at.err) return json(at.err.body, at.err.status);
      const accessToken = at.token!;

      const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads");
      listUrl.searchParams.set("maxResults", String(Math.min(Number(body.maxResults) || 25, 50)));
      if (typeof body.q === "string" && body.q.trim()) listUrl.searchParams.set("q", body.q.trim());
      const lr = await fetch(listUrl.toString(), { headers: { Authorization: "Bearer " + accessToken } });
      const ld = await lr.json().catch(() => ({}));
      if (!lr.ok) return json({ error: ld?.error?.message || "Gmail list failed." }, lr.status);

      const ids: string[] = (ld.threads || []).map((t: any) => t.id).filter(Boolean);
      // One metadata fetch per thread (Gmail's list endpoint doesn't return
      // headers) — fine at mailbox scale (<=50), parallelized.
      const threads = await Promise.all(ids.map(async (id) => {
        const tUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads/" + encodeURIComponent(id));
        tUrl.searchParams.set("format", "metadata");
        tUrl.searchParams.append("metadataHeaders", "From");
        tUrl.searchParams.append("metadataHeaders", "Subject");
        tUrl.searchParams.append("metadataHeaders", "Date");
        const tr = await fetch(tUrl.toString(), { headers: { Authorization: "Bearer " + accessToken } });
        if (!tr.ok) return null;
        const td = await tr.json().catch(() => null);
        const msgs = td?.messages || [];
        const last = msgs[msgs.length - 1];
        if (!last) return null;
        const headers = last.payload?.headers || [];
        return {
          id,
          permalink: gmailPermalink(id),
          from: gmailHeader(headers, "From"),
          subject: gmailHeader(headers, "Subject") || "(no subject)",
          date: gmailHeader(headers, "Date"),
          snippet: last.snippet || td?.snippet || "",
          messageId: last.id || null,
          messageCount: msgs.length,
        };
      }));
      return json({ threads: threads.filter(Boolean) }, 200);
    }

    // ── Mailbox: one full thread (task drawer's Email tab reader) ──
    if (action === "gmail_thread") {
      const at = await callerAccessToken(sb, auth.userId);
      if (at.err) return json(at.err.body, at.err.status);
      if (!body.threadId) return json({ error: "Missing threadId." }, 400);

      const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/threads/" + encodeURIComponent(body.threadId));
      url.searchParams.set("format", "full");
      const r = await fetch(url.toString(), { headers: { Authorization: "Bearer " + at.token } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: d?.error?.message || "Gmail thread fetch failed." }, r.status);

      const messages = (d.messages || []).map((m: any) => {
        const headers = m.payload?.headers || [];
        return {
          id: m.id,
          from: gmailHeader(headers, "From"),
          to: gmailHeader(headers, "To"),
          date: gmailHeader(headers, "Date"),
          subject: gmailHeader(headers, "Subject"),
          bodyText: gmailBodyText(m.payload),
          snippet: m.snippet || "",
        };
      });
      const subject = messages.length ? messages[0].subject : "";
      return json({ thread: { id: d.id, subject, permalink: gmailPermalink(d.id), messages } }, 200);
    }

    // ── Contact summary for one call row. See the AUTH NOTE at the top. ──
    if (action === "contact_brief") {
      const contactId = String(body.contact_id || "").trim();
      if (!/^\d+$/.test(contactId)) return json({ error: "bad_contact_id" }, 400);
      // contact_id is the ONLY input. Nothing else on the body is read, ever —
      // if the client could name a mailbox or supply a Gmail query, the client
      // would be the authorization boundary.

      // (1) The caller with their roles, and (2) the hourly ceiling per viewer.
      //     Two independent reads of two different tables, so they go together.
      //     authorizeCaller above only selected `status`, which is all the other
      //     actions in this file need.
      //
      //     The ceiling exists because without one, a single session can walk
      //     every contact the firm owns and come away with a readable digest of
      //     two colleagues' recent mail — plus the AI bill and the Zoho credits.
      const since = new Date(Date.now() - 3600000).toISOString();
      const [meRes, rlRes] = await Promise.all([
        sb.from("profiles")
          .select("id, status, access, assigned_tc").eq("id", auth.userId).single(),
        sb.from("contact_brief_reads")
          .select("id", { count: "exact", head: true })
          .eq("viewer_id", auth.userId).gte("created_at", since),
      ]);
      const me: any = meRes.data;
      if (!me || me.status !== "active") return json({ error: "Account is not active." }, 403);
      const roles: string[] = Array.isArray(me.access)
        ? me.access.map((r: any) => String(r).toLowerCase())
        : String(me.access || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
      const isAdmin = roles.some((r) => r === "admin" || r === "operations");
      if ((rlRes.count || 0) >= CB_READS_PER_HOUR) {
        return json({ error: "rate_limited", retry_after_minutes: 60 }, 429);
      }

      // (3) The contact, its owner, its deals and its call history — one call.
      //     The caller's own bearer is forwarded so zoho-crm re-checks them too.
      const zr = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/zoho-crm", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: req.headers.get("Authorization") || "",
        },
        body: JSON.stringify({ action: "contact_facts", contact_id: contactId }),
      });
      const zd = await zr.json().catch(() => ({}));
      if (!zr.ok) return json({ error: "zoho_unavailable", retryable: true }, 502);
      if (!zd.found || !zd.contact) return json({ error: "contact_not_found" }, 404);
      const contact = zd.contact;

      // The contact's prospect-form fields, grouped by form type. Deliberately
      // NOT summarised by the model: these are already structured, and a
      // "Budget: $650k" the model paraphrased is a number it could get wrong.
      // The client prints them verbatim. The model still SEES them below, so
      // the deals and touch lines can read as though it knows the client.
      let prospect: any = null;
      try {
        const pr = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/zoho-crm", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: req.headers.get("Authorization") || "" },
          body: JSON.stringify({ action: "prospect_form", contact_id: contactId }),
        });
        if (pr.ok) {
          const pd = await pr.json().catch(() => ({}));
          if (pd && Array.isArray(pd.groups)) prospect = pd;
        } else { try { await pr.body?.cancel(); } catch { /* drained */ } }
      } catch { /* a missing prospect form must never cost the whole brief */ }

      // (4) Zoho Owner id → TMG profile, by STORED ID only. Never by name: the
      //     loose bidirectional substring match used to shade the capacity grid
      //     is right there and wrong here — it would pick a mailbox. Migration
      //     20260905100000_profiles_zoho_user_id.sql exists because name and
      //     email matching mis-filed two people's records.
      const ownerZid = contact.owner && contact.owner.id;
      const { data: agent } = ownerZid
        ? await sb.from("profiles")
            .select("id, first_name, last_name, email, status, assigned_tc")
            .eq("zoho_user_id", String(ownerZid)).maybeSingle()
        : { data: null } as any;
      if (!agent) {
        // Hundreds of contacts in this org are still owned by people who have
        // left. That is a different sentence from "not linked yet", and the
        // client says so.
        return json({
          error: "owner_unresolved",
          owner_name: (contact.owner && contact.owner.name) || null,
        }, 409);
      }

      // (5) AUTHORIZATION. reports_to is deliberately not here: the Calls tab
      //     only shows other people's rows to admins today, so a manager branch
      //     would be dead code carrying live risk.
      const permitted = me.id === agent.id || me.id === agent.assigned_tc || isAdmin;
      if (!permitted) return json({ error: "not_permitted" }, 403);

      const { data: tc } = agent.assigned_tc
        ? await sb.from("profiles")
            .select("id, first_name, last_name, email, status")
            .eq("id", agent.assigned_tc).maybeSingle()
        : { data: null } as any;

      // (6) Search. No email on file means nothing to search — return without
      //     spending a Gmail call or an AI call.
      let mailboxes: any[] = [];
      if (contact.email) {
        // An agent who is somehow their own TC would otherwise be minted twice
        // and read twice, and the model would see the same thread as two.
        const targets: Array<[string, any]> = [["agent", agent]];
        if (!tc || tc.id !== agent.id) targets.push(["tc", tc]);
        // Both mailboxes are searched at the same time. Each one is a token
        // mint, a threads.list and up to three metadata GETs, and they were
        // queued one behind the other for two reads that never look at each
        // other's result.
        //
        // Promise.all is fail-fast and the Gmail fetches inside cbSearchMailbox
        // have no try/catch of their own, so each leg carries its own. The
        // fallback rebuilds the WHOLE shape: a bare { state } would drop role
        // and name, and the sheet's gap note would read "undefined couldn't be
        // searched".
        mailboxes = await Promise.all(targets.map(([role, person]) =>
          cbSearchMailbox(sb, person, role, contact.email).catch(() => ({
            role, name: cbName(person), state: "search_failed", threads: 0, lines: [] as string[],
          }))
        ));
      }

      const threadLines = mailboxes.flatMap((m) => m.lines || []);
      const threadsRead = threadLines.length;

      const money = (n: any) => (n == null ? "" : " $" + Number(n).toLocaleString("en-US"));
      const deals = (zd.deals || []).map((d: any) =>
        `- ${d.name || "(unnamed deal)"} | stage ${d.stage || "unknown"}${money(d.amount)}` +
        `${d.closing_date ? " | closing " + d.closing_date : ""}${d.type ? " | " + d.type : ""}`);
      const today = new Date().toISOString().slice(0, 10);

      // A touch is something that HAPPENED. Zoho's related list comes back in
      // no particular date order and is capped, so a contact with a couple of
      // appointments booked can arrive with every future task at the top and
      // no past one in the window at all. Handed that, the model said the last
      // touch was "a call scheduled for 2026-09-18" -- a date that has not
      // happened yet, printed as history, which is exactly the lie an agent
      // would carry into the conversation.
      //
      // So the two are split HERE, by date, rather than left for the model to
      // tell apart in prose. Done is done: a Closed_Time, a completed status,
      // or a due date already past. Everything else is a plan.
      const tDate = (t: any) => String(t.closed || t.due || "").slice(0, 10);
      const tDone = (t: any) =>
        !!t.closed || /complet/i.test(String(t.status || "")) || (!!tDate(t) && tDate(t) <= today);
      const dated = (zd.tasks || []).filter((t: any) => tDate(t));
      const donePast = dated.filter(tDone)
        .sort((a: any, b: any) => (tDate(a) < tDate(b) ? 1 : tDate(a) > tDate(b) ? -1 : 0))
        .slice(0, 8);
      const upcoming = dated.filter((t: any) => !tDone(t))
        .sort((a: any, b: any) => (tDate(a) > tDate(b) ? 1 : tDate(a) < tDate(b) ? -1 : 0))
        .slice(0, 4);
      const line = (t: any) =>
        `- ${tDate(t)} | ${t.status || "?"}${t.type ? " | " + t.type : ""} | ${t.subject || ""}`;
      const touches = donePast.map(line);
      const planned = upcoming.map(line);

      // The newest touch of each KIND — one "Call", one "Note", one "Email" —
      // rather than the newest few touches, which on a busy contact are all the
      // same kind and hide the fact that nobody has phoned since March.
      //
      // "Done" is deliberately strict: a task dated next Tuesday is a plan, not
      // a touch, and printing it as the last call would be a lie the agent
      // would carry into the conversation. Closed_Time OR a completed status OR
      // a due date already in the past all count; anything else is skipped.
      const lastByType: Array<{ type: string; date: string }> = [];
      if (zd.tasks_type_read) {
        const seen = new Set<string>();
        for (const t of (zd.tasks || [])) {
          const type = String(t.type || "").trim();
          if (!type || seen.has(type.toLowerCase())) continue;
          const date = String(t.closed || t.due || "").slice(0, 10);
          if (!date) continue;
          const done = !!t.closed || /complet/i.test(String(t.status || "")) || date <= today;
          if (!done) continue;
          seen.add(type.toLowerCase());
          lastByType.push({ type, date });
        }
        lastByType.sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
      }

      // Mail that Zoho already holds on the contact record — the Emails tab an
      // agent sees on the profile, fed by each agent's IMAP sync. This is the
      // source that had the July newsletter all along: it was BCC'd, so the
      // Gmail search could not match it, but Zoho filed it against the contact
      // anyway. Subject, direction and date only.
      const zohoMail = (zd.emails || []).slice(0, CB_ZOHO_EMAILS).map((m: any) =>
        `- ${String(m.time || "").slice(0, 10)} | ${m.sent ? "sent to them" : "received from them"}` +
        `${m.from ? " | from " + m.from : ""} | ${m.subject || "(no subject)"}`);

      // The span the Zoho mail actually covers. Dates are primitives, not
      // content, so this crosses the wire where the subjects do not -- and it
      // is the cheapest possible check on the model: if the brief says 2020 and
      // the span says 2026, the brief is wrong and anyone can see it.
      //
      // The regex is doing real work. Zoho's `time` is only sliceable if it is
      // ISO; anything else silently yields a garbage prefix, so a non-match
      // means "these dates are not readable", which the sheet then says out
      // loud instead of printing nonsense.
      const mailDates = (zd.emails || [])
        .map((m: any) => String(m.time || "").slice(0, 10))
        .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      const emailSpan = mailDates.length
        ? { first: mailDates[0], last: mailDates[mailDates.length - 1] }
        : null;

      let ctx = [
        `TODAY: ${new Date().toISOString().slice(0, 10)}`,
        `CONTACT: ${contact.full_name || "(unnamed)"}` +
          `${contact.classification ? " | classification " + contact.classification : ""}` +
          `${contact.city ? " | " + contact.city + (contact.state ? ", " + contact.state : "") : ""}` +
          `${contact.lead_source ? " | source " + contact.lead_source : ""}` +
          `${contact.created ? " | in the CRM since " + String(contact.created).slice(0, 10) : ""}`,
        `OWNING AGENT: ${cbName(agent)}`,
        "",
        deals.length ? "DEALS:" : (zd.deals_read ? "DEALS: none open." : "DEALS: could not be read."),
        ...deals,
        "",
        touches.length
          ? "DONE — TASKS THAT HAVE ALREADY HAPPENED (newest first). ANY type counts as a touch:"
          : (zd.tasks_read ? "DONE — TASKS THAT HAVE ALREADY HAPPENED: none on record." : "TASK HISTORY: could not be read."),
        ...touches,
        "",
        planned.length ? "SCHEDULED — NOT YET HAPPENED. These are plans, never a touch:" : "SCHEDULED: nothing booked.",
        ...planned,
        "",
        threadLines.length ? "RECENT EMAIL FROM MAILBOX SEARCH (subject, sender, first line only):" : "RECENT EMAIL FROM MAILBOX SEARCH: none found.",
        ...threadLines,
        "",
        // Named as a separate source on purpose. The two overlap — a reply the
        // agent sent is in both — and a model told these were one list would
        // count the same exchange twice. It is also the only place a mass
        // send shows up, so it deserves its own heading rather than being
        // folded in as more of the same.
        zohoMail.length
          ? "EMAIL ON THE ZOHO CONTACT RECORD (may repeat the above; also includes mass sends such as newsletters):"
          : (zd.emails_state === "read" || zd.emails_state === "none"
              ? "EMAIL ON THE ZOHO CONTACT RECORD: none on file."
              : "EMAIL ON THE ZOHO CONTACT RECORD: could not be read."),
        ...zohoMail,
        "",
        // Context only. The client renders these itself, field by field, so
        // the model must not spend a section repeating them back.
        ...(prospect && prospect.groups && prospect.groups.length
          ? prospect.groups.flatMap((g: any) => [
              `PROSPECT FORM — ${g.title} (background. Do NOT give this its own section; use it to make the other lines specific):`,
              ...(g.fields || []).slice(0, 25).map((f: any) => `- ${f.label}: ${f.value}`),
            ])
          : []),
      ].join("\n");
      // Belt and braces. The caps above should already keep this near 6k, but a
      // silent overrun would hit ai-chat's 413 and show the wrong error entirely.
      if (ctx.length > CB_MAX_CONTEXT_CHARS) ctx = ctx.slice(0, CB_MAX_CONTEXT_CHARS);

      // Nothing at all to summarise: don't pay a model to say so.
      let brief = "";
      if (deals.length || touches.length || planned.length || threadLines.length || zohoMail.length) {
        const ar = await fetch(Deno.env.get("SUPABASE_URL") + "/functions/v1/ai-chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: req.headers.get("Authorization") || "",
          },
          body: JSON.stringify({
            messages: [{ role: "user", content: ctx }],
            system: CONTACT_BRIEF_SYSTEM,
            max_tokens: CB_MAX_TOKENS,
            feature: "contact_summary",
            // A two-to-four-sentence brief off a 6k context is the cheapest,
            // most mechanical job the app gives a model, and it is the one the
            // agent actually waits on. ai_config.model_fast decides what that
            // means; if that column is blank, ai-chat falls back to the one
            // app-wide model and this line changes nothing.
            tier: "fast",
          }),
        });
        const ad = await ar.json().catch(() => ({}));
        if (!ar.ok) return json({ error: "ai_unavailable", retryable: true }, 502);
        brief = String(ad.text || "").trim();
      }

      // (7) The trail. Best-effort: a logging failure must not lose the answer
      //     the viewer already paid for.
      const auditP = Promise.resolve(
        sb.from("contact_brief_reads").insert({
          viewer_id: auth.userId,
          contact_id: contactId,
          agent_id: agent.id,
          tc_id: tc ? tc.id : null,
          mailboxes_read: mailboxes.filter((m) => m.state === "searched").map((m) => m.role),
          threads_read: threadsRead,
        })
      ).then(() => {}, () => {});
      // waitUntil keeps the worker alive past the response, so the row still
      // lands and the viewer doesn't wait for it. Where it isn't available we
      // take the round trip rather than fire and forget: this row is the record
      // of who read whose mailbox, and a dropped one is a hole in that record,
      // not a missing metric.
      const waitUntil = (globalThis as any).EdgeRuntime?.waitUntil;
      if (typeof waitUntil === "function") waitUntil.call((globalThis as any).EdgeRuntime, auditP);
      else await auditP;

      // Prose and primitives only. No thread ids, message ids, permalinks,
      // subjects, snippets or addresses — a viewer must not be handed
      // identifiers for a mailbox they cannot open.
      return json({
        brief,
        classification: contact.classification || null,
        contact_email_on_file: !!contact.email,
        deals_read: !!zd.deals_read,
        tasks_read: !!zd.tasks_read,
        // Newest touch per kind. Empty when Zoho refused Task_Type as well as
        // when there are genuinely no completed tasks — the sheet only prints a
        // heading when there is at least one row, so both read the same way.
        last_by_type: lastByType,
        // How many emails Zoho already had on the record, and why there were
        // none if there were none. Counts and a state word only — the subjects
        // stay server-side, same rule as the mailbox search.
        zoho_emails: zohoMail.length,
        zoho_emails_state: zd.emails_state || "failed",
        // { first, last } as plain YYYY-MM-DD, or null when Zoho's dates were
        // not in a readable format. Null WITH a non-zero count is the tell.
        zoho_email_span: emailSpan,
        // { types[], groups[{title, source, fields[{api,label,type,value,options,read_only}]}] }
        // `source` is "section" when Zoho's own layout supplied the grouping and
        // "filled" when it was inferred from which fields carry a value.
        prospect,
        // null = the tag lookup was dropped, [] = read and there are none.
        tags: Array.isArray(contact.tags) ? contact.tags : null,
        threads_read: threadsRead,
        mailboxes: mailboxes.map((m) => ({ role: m.role, name: m.name, state: m.state, threads: m.threads })),
        generated_at: new Date().toISOString(),
      }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
