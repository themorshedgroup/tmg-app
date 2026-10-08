// ─── call-audit ─────────────────────────────────────────────────────────
// Pulls the transcripts and Gemini notes of Tarek's calls with Operations
// into public.call_audit_items, so those calls can be audited.
//
// Why Tarek's calendar: Meet saves a transcript in the HOST's Drive, not the
// recorder's, and Tarek is often not the host. But every invited TMG person
// gets the link attached to the calendar event and can open it. So reading the
// attachments on HIS events, with HIS grant, catches every Ops call whoever
// hosted it.
//
// Access: Tarek's stored Google refresh token (google_tokens). It only works
// for this after he taps Allow on the Tarek-only "Call audit" row in his Profile
// settings, which adds drive.readonly to his grant. Without it, the run stops
// with `no_drive_scope` and reads nothing.
//
// Who counts as Ops: everyone invited to an "Operations Weekly ..." event on
// his calendar in the window (minus Tarek), unless `ops_emails` is passed.
//
// Caller: no user session (run from SQL via pg_net). The bearer must match the
// vault secret `call_audit_secret`, checked by call_audit_secret_ok(). The
// platform login check is off via [functions.call-audit] in config.toml.
//
//   { action: 'collect', since?: '2026-09-01', ops_emails?: string[] }
//
// Nightly: pg_cron job `call-audit-nightly` (10 PM Manila) collects the last 3 days.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Public OAuth client id, copied verbatim from google-calendar/index.ts.
const GOOGLE_CLIENT_ID = "931478099859-9jifv0fl9v3s67oc7pa5ka6j61eeujfq.apps.googleusercontent.com";
const TAREK_EMAIL = "tarek@themorshedgroup.com";
const TMG_DOMAIN = "@themorshedgroup.com";
const OPS_MEETING = /operations\s+weekly/i;
const DOC_MIME = "application/vnd.google-apps.document";
const MAX_CHARS = 400_000;
const ROSTER_DAYS = 45;

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

// Verbatim shape from google-calendar/index.ts.
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

async function gget(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 300)}`);
  return res;
}

// All text of a Google Doc, every tab included. Gemini puts the summary and
// the transcript in separate tabs; a plain Drive export can miss the second.
function docText(doc: any): string {
  const out: string[] = [];
  const walk = (content: any[]) => {
    for (const el of content || []) {
      if (el.paragraph) {
        for (const pe of el.paragraph.elements || []) if (pe.textRun?.content) out.push(pe.textRun.content);
      } else if (el.table) {
        for (const row of el.table.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content);
      } else if (el.tableOfContents) {
        walk(el.tableOfContents.content);
      }
    }
  };
  const walkTabs = (tabs: any[]) => {
    for (const t of tabs || []) {
      const title = t.tabProperties?.title;
      if (title) out.push(`\n\n=== ${title} ===\n`);
      walk(t.documentTab?.body?.content);
      walkTabs(t.childTabs);
    }
  };
  if (Array.isArray(doc.tabs) && doc.tabs.length) walkTabs(doc.tabs);
  else walk(doc.body?.content);
  return out.join("");
}

async function fetchDoc(fileId: string, token: string): Promise<string> {
  try {
    const res = await gget(`https://docs.googleapis.com/v1/documents/${fileId}?includeTabsContent=true`, token);
    return docText(await res.json());
  } catch (_) {
    // Fallback: plain export (first tab only on some docs, but better than nothing).
    const res = await gget(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, token);
    return await res.text();
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const sb = serviceClient();
  if (!sb) return json({ error: "server not configured" }, 500);

  const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  const { data: ok } = await sb.rpc("call_audit_secret_ok", { p: bearer });
  if (!bearer || ok !== true) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({}));
  if (body.action !== "collect") return json({ error: "Unknown action." }, 400);

  const since = new Date(body.since || "2026-09-01T00:00:00-05:00");
  if (isNaN(since.getTime())) return json({ error: "bad since" }, 400);

  // Tarek's grant.
  const { data: prof } = await sb.from("profiles").select("id").ilike("email", TAREK_EMAIL).maybeSingle();
  if (!prof?.id) return json({ error: "Tarek profile not found" }, 404);
  const { data: tok } = await sb.from("google_tokens").select("refresh_token").eq("user_id", prof.id).maybeSingle();
  if (!tok?.refresh_token) return json({ error: "needs_connect" }, 409);
  let access: string;
  try { access = await googleAccessToken(tok.refresh_token); }
  catch (e) { return json({ error: "needs_connect: " + String((e as any)?.message || e) }, 409); }

  const info = await (await fetch("https://oauth2.googleapis.com/tokeninfo?access_token=" + access)).json().catch(() => ({}));
  const scopes = String(info.scope || "").split(" ");
  if (!scopes.some((s) => s.endsWith("/auth/drive.readonly") || s.endsWith("/auth/drive"))) {
    // Scope names are not secret, and they show WHICH connect flow last ran.
    return json({ error: "no_drive_scope", hint: "Tarek has not tapped Allow on Call audit yet.", granted: scopes }, 409);
  }

  // His events in the window. The list reaches back at least ROSTER_DAYS so the
  // Ops roster (from "Operations Weekly" invites) still fills on a short nightly
  // window; only events from `since` on are collected.
  const listFrom = new Date(Math.min(since.getTime(), Date.now() - ROSTER_DAYS * 86400000));
  const events: any[] = [];
  let pageToken = "";
  do {
    const q = new URLSearchParams({
      timeMin: listFrom.toISOString(), timeMax: new Date().toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "250",
      fields: "nextPageToken,items(id,summary,start,status,organizer(email),attendees(email,self,responseStatus,resource),attachments(fileId,title,mimeType))",
    });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await (await gget(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, access)).json();
    events.push(...(page.items || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);

  const emailsOf = (ev: any) =>
    (ev.attendees || []).filter((a: any) => !a.resource && a.email).map((a: any) => String(a.email).toLowerCase());

  // Ops roster.
  let ops = new Set<string>((body.ops_emails || []).map((e: string) => e.toLowerCase()));
  if (!ops.size) {
    for (const ev of events) {
      if (!OPS_MEETING.test(ev.summary || "")) continue;
      for (const e of emailsOf(ev)) if (e.endsWith(TMG_DOMAIN) && e !== TAREK_EMAIL) ops.add(e);
    }
  }

  const calls: any[] = [];
  for (const ev of events) {
    if (ev.status === "cancelled") continue;
    const start = new Date(ev.start?.dateTime || ev.start?.date || 0);
    if (start < since) continue;
    const me = (ev.attendees || []).find((a: any) => a.self);
    if (me?.responseStatus === "declined") continue;
    const who = emailsOf(ev);
    const opsHere = who.filter((e) => ops.has(e));
    if (!opsHere.length) continue;
    const docs = (ev.attachments || []).filter((a: any) => a.mimeType === DOC_MIME && a.fileId);
    calls.push({ ev, who, opsHere, docs });
  }

  const results: any[] = [];
  for (const c of calls) {
    for (const d of c.docs) {
      let content: string | null = null, fetchError: string | null = null;
      try { content = (await fetchDoc(d.fileId, access)).slice(0, MAX_CHARS); }
      catch (e) { fetchError = String((e as any)?.message || e).slice(0, 500); }
      const row = {
        event_id: c.ev.id, event_title: c.ev.summary || null,
        event_start: c.ev.start?.dateTime || c.ev.start?.date || null,
        organizer: c.ev.organizer?.email || null, attendees: c.who, ops_present: c.opsHere,
        file_id: d.fileId, file_title: d.title || null, mime_type: d.mimeType,
        content, chars: content ? content.length : null, fetch_error: fetchError,
        fetched_at: new Date().toISOString(),
      };
      const { error } = await sb.from("call_audit_items").upsert(row, { onConflict: "event_id,file_id" });
      results.push({ title: row.event_title, start: row.event_start, file: row.file_title, chars: row.chars, error: fetchError || error?.message || null });
    }
  }

  return json({
    ok: true,
    window_start: since.toISOString(),
    events_scanned: events.length,
    ops: [...ops],
    ops_calls: calls.length,
    ops_calls_without_transcript: calls.filter((c) => !c.docs.length).length,
    docs: results,
  });
});
