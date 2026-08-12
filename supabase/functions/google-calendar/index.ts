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
