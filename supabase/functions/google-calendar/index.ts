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
// Prereqs: Google Calendar API + Google Tasks API enabled in the Cloud project;
// the OAuth consent screen includes `.../auth/calendar.events` and
// `.../auth/tasks`; the app requests both at "Connect"/"Reconnect" with
// access_type=offline so a refresh token is issued (see supabase.js).
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
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
