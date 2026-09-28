// ─────────────────────────────────────────────────────────────────────────
// TMG App, Supabase Edge Function: zoho-projects-poll
// Zoho Projects → TMG pull direction (plan: hidden-wiggling-lamport §4).
// Cron-invoked every 5 min (pg_cron), same overall shape as sffu-sender: a
// shared-secret header authenticates the caller instead of a user session.
// Uses its OWN secret (ZOHO_POLL_CRON_SECRET), deliberately NOT sffu-sender's
// CRON_SECRET: keeps the two cron jobs fully independent so a rotation or
// issue on one never touches the other.
//
// Deploy: `supabase functions deploy zoho-projects-poll --no-verify-jwt`.
//   Leave "Verify JWT" OFF: auth is the secret check below, not a Supabase
//   session (there is no user).
//
// Secrets:
//   ZOHO_POLL_CRON_SECRET = long random string, only this function + its
//                            pg_cron job (migration 20260826_...) know it
//   ZOHO_CLIENT_ID        = same Zoho API client as zoho-projects/zoho-crm
//   ZOHO_CLIENT_SECRET
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// Self-contained by convention (no sibling imports): the token-mint/cache
// helpers and Zoho field-mapping functions here are deliberately duplicated
// from zoho-projects/index.ts rather than shared.
//
// One `list_tasks` call PER LINKED CTC FILE per cycle (not per task) to stay
// under Zoho Projects' 100-calls/2-min rate limit, plus one more per extra
// page on a project with more tasks than a page holds. See the interval math
// note near the bottom of this file before changing the cron schedule.
//
// Conflict rule (plan §5, confirmed): last-write-wins by timestamp, always
// logged: no on-screen recovery banner, just a queryable row in
// zoho_sync_conflicts plus a plain-English task_activity entry.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

// ── Zoho OAuth token mint/cache, duplicated from zoho-projects/index.ts ──
async function mintZohoToken(refreshToken: string, accountsUrl: string) {
  const clientId = Deno.env.get("ZOHO_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("ZOHO_CLIENT_SECRET") || "";
  const body = new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret, grant_type: "refresh_token" });
  const res = await fetch(`${accountsUrl}/oauth/v2/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || data.error || "Failed to refresh Zoho token");
  const expiresIn = Number(data.expires_in) || 3600;
  return { access_token: data.access_token, expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() };
}
async function getZohoToken(sb: any, conn: any): Promise<string> {
  const BUFFER_MS = 5 * 60 * 1000;
  const exp = conn.access_token_expires_at ? Date.parse(conn.access_token_expires_at) : 0;
  if (conn.access_token && exp && exp - Date.now() > BUFFER_MS) return conn.access_token;
  const minted = await mintZohoToken(conn.refresh_token, conn.accounts_url || "https://accounts.zoho.com");
  try { await sb.from("zoho_projects_connection").update({ access_token: minted.access_token, access_token_expires_at: minted.expires_at }).eq("refresh_token", conn.refresh_token); } catch (_) {}
  conn.access_token = minted.access_token; conn.access_token_expires_at = minted.expires_at;
  return minted.access_token;
}

// ── Date/field mapping, duplicated from zoho-projects/index.ts (plan §2.1
// flags both the date format and the priority/status label sets as needing
// live confirmation against the real portal; keep these two files in sync
// if that mapping is corrected). ──
// The brokerage's own zone, and the only zone any of this is read through:
// accountability_weeks buckets on it, and the app reads due_at through it too.
// Named once rather than written into each call, so the two copies of this
// file cannot drift apart on the one thing that decides what day a task is due.
const TMG_TZ = "America/Chicago";
// Deno runs in UTC, so Date's own getters cannot answer a question about
// Chicago, and Intl is the only thing here that knows when the clocks move.
function zoneParts(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  // en-US with hour12:false spells midnight as hour 24, so fold it back to 0.
  return { year: g("year"), month: g("month"), day: g("day"), hour: g("hour") % 24, minute: g("minute"), second: g("second") };
}
// How far the zone sits from UTC at that instant, DST included: read the
// instant as wall clock there, then treat that reading as if it were UTC. The
// gap between the two is the offset.
function zoneOffsetMs(ms: number, tz: string): number {
  const w = zoneParts(ms, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms;
}
// Midnight on a calendar date IN that zone, as the UTC instant it really is.
// Two passes because the offset that applies is the one at the answer, not the
// one at the first guess, and those two differ on the days the clocks move.
function zoneMidnightMs(y: number, m: number, d: number, tz: string): number {
  const naive = Date.UTC(y, m - 1, d);
  return naive - zoneOffsetMs(naive - zoneOffsetMs(naive, tz), tz);
}
// A Zoho end_date is a CALENDAR DATE with no time of day, so the only thing
// that matters is what day it reads back as. Midnight UTC was the wrong answer
// to that: the app and accountability_weeks both read due_at through
// America/Chicago, where midnight UTC lands in the evening of the day BEFORE,
// so all 1402 dated rows this pull had written were stored, shown and scored a
// day early. Midnight in this zone is the same instant the app itself stores
// for a date typed with no time (src/tasks.jsx builds "YYYY-MM-DDT00:00" and
// lets the browser resolve it), so a Zoho-sourced date and a TMG-sourced date
// are now the same kind of value and behave the same way in the same view.
function zohoDateToIso(mmddyyyy: string | null | undefined): string | null {
  if (!mmddyyyy) return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(mmddyyyy.trim()); if (!m) return null;
  const ms = zoneMidnightMs(Number(m[3]), Number(m[1]), Number(m[2]), TMG_TZ);
  return isNaN(ms) ? null : new Date(ms).toISOString();
}
// The other half of the round trip, so it has to read the day in the SAME zone
// or a date pulled out of Zoho would go back into Zoho a day earlier than it
// came. Reading it in UTC is also what sent a task due at 7pm here to Zoho as
// the following day.
// A bare "YYYY-MM-DD" is already a calendar date and goes straight through:
// zoho-projects pushes project dates in that form, straight off the date
// columns projects.started_at/target_date, and putting a zone anywhere near a
// value that has no time of day is how it would move by a day.
function isoToZohoDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
  if (bare) return `${bare[2]}-${bare[3]}-${bare[1]}`;
  const ms = Date.parse(String(iso)); if (isNaN(ms)) return null;
  const w = zoneParts(ms, TMG_TZ);
  return `${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}-${w.year}`;
}
function tmgPriorityToZoho(p: string | null | undefined): string {
  if (p === "high") return "High"; if (p === "low") return "Low"; return "Medium";
}
function zohoPriorityToTmg(p: string | null | undefined): string {
  const s = (p || "").toLowerCase();
  if (s.includes("high") || s.includes("urgent")) return "high";
  if (s.includes("low") || s === "none") return "low";
  return "medium";
}
function tmgStatusToZoho(s: string | null | undefined): string {
  if (s === "done") return "Closed"; if (s === "in_progress") return "In Progress"; return "Open";
}
function zohoStatusToTmg(s: string | null | undefined): string {
  const v = (s || "").toLowerCase();
  if (v.includes("close") || v.includes("complet")) return "done";
  if (v.includes("progress")) return "in_progress";
  return "todo";
}
// A due date moving is the change the team most wants a paper trail for
// ("how many times did this closing slip, and when?"), and most of those edits
// happen in Zoho's own UI, where this loop used to overwrite due_at in silence.
// Phrased like TaskDB.update phrases an in-app edit, so both kinds of change
// read as one timeline on the task.
// Two sides spell the same moment differently, so text comparison is the
// wrong question to ask of a date. PostgREST renders a stored timestamptz as
// "2026-09-14T05:00:00+00:00" and zohoDateToIso hands back
// "2026-09-14T05:00:00.000Z": not equal as strings, the same instant in fact.
// Comparing them as strings read every dated task as changed, which on the
// first catch-up run would have written "Due date moved from Sep 14 to Sep 14"
// onto 1402 of the 1408 dated tasks, in the history a person reads. Only 6 of
// them carry a real time of day, so only 6 could have moved at all.
function sameMoment(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v == null || v === "";
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  const x = Date.parse(String(a)), y = Date.parse(String(b));
  // Unparseable on either side is not a moment, so fall back to the text.
  return isNaN(x) || isNaN(y) ? String(a) === String(b) : x === y;
}
// Two different things reach this function and only one of them is a moment.
// Midnight UTC is how a Zoho calendar date was spelled BEFORE zohoDateToIso
// was corrected above, and 1402 stored rows still hold that spelling until the
// catch-up run rewrites them. Read through America/Chicago those land five
// hours back in the day before, so printing them in UTC is what says the day
// Zoho actually means. Everything else here is a real moment and wants the
// brokerage's own zone (accountability_weeks buckets on 'America/Chicago' for
// the same reason), which is also where a corrected Zoho date now belongs:
// this zone's midnight is never exactly midnight UTC, so the two cannot be
// mistaken for each other.
// This branch is what keeps the first catch-up run silent. It reads the old
// spelling and the new one and gets the same day out of both, so
// dueDateMovedLine has nothing to report on any of the 1402 rows whose stored
// value it is about to correct, and the fabricated "Due date moved from Sep 14
// to Sep 14" lines the last pass drove to zero stay at zero.
// The cost is a TMG task set to exactly 6pm here in winter (7pm in summer),
// which IS midnight UTC and gets read as a calendar date, printing that one
// label a day late. That was already true before this change. Once the poll
// has rewritten the 1402 rows, nothing in the table is midnight UTC except
// such a task, and this branch can be deleted outright.
function shortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const calendarDate = d.getTime() % 86400000 === 0;
  return d.toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
    timeZone: calendarDate ? "UTC" : "America/Chicago",
  });
}
function dueDateMovedLine(oldIso: string | null, newIso: string | null): string | null {
  if (sameMoment(oldIso, newIso)) return null;
  const a = shortDate(oldIso), b = shortDate(newIso);
  // Both ends print the same day, so the line has nothing left to say: it
  // speaks in days only, and Zoho's end_date cannot carry a time of day at
  // all, so the 6 dated tasks here that do carry one lose it to the pull and
  // would each read "Due date moved from Sep 14 to Sep 14" once. A within-day
  // move is not something this line could ever report, so nothing is lost.
  if (a && b && a === b) return null;
  if (!a && b) return `Due date set to ${b} (changed in Zoho Projects)`;
  if (a && !b) return `Due date cleared (was ${a}), changed in Zoho Projects`;
  if (a && b) return `Due date moved from ${a} to ${b} (changed in Zoho Projects)`;
  return null;
}

// ── Three fields Zoho does not spell the way this file assumed ────────────
// Each is read through a list of candidate names rather than one, because the
// portal cannot be queried from here and the cost of guessing wrong is
// lopsided: a field that reads null looks exactly like a task nobody has
// touched, which is how zoho_last_modified_time stayed null on all 2810
// imported rows for a month with nothing on screen to show for it.

// The change cursor. Zoho's QUERY parameter is called last_modified_time, but
// the task object it hands back carries no last_modified_time_long: 2803 rows
// written by this job took their tasklist id and name off the same payload in
// the same insert statement, and not one of them got a timestamp, which is
// what an absent field looks like. The pair Zoho documents on a task is
// last_updated_time, so try that spelling first and keep the old one behind
// it. The _long variants are already epoch milliseconds, the plain ones are
// display strings, and any stable number will do: this value is only ever
// compared with the last one, never shown.
function zohoModifiedMs(t: any): number | null {
  for (const v of [t.last_updated_time_long, t.last_modified_time_long]) {
    if (v != null && v !== "" && !isNaN(Number(v))) return Number(v);
  }
  for (const v of [t.last_updated_time, t.last_modified_time]) {
    if (v) { const ms = Date.parse(String(v)); if (!isNaN(ms)) return ms; }
  }
  return null;
}

// When Zoho answers to none of those names, fall back to a fingerprint of the
// fields this sync actually carries. It is not a time and never pretends to be
// one. It exists so the change detector can SETTLE: treating a missing
// timestamp as "changed" is the right fail-safe, but on its own it means every
// task reads as changed on every tick forever and the job never stops
// rewriting rows nobody edited. A fingerprint changes exactly when the synced
// content changes, which is the only question the detector actually asks.
function zohoFingerprint(t: any): number {
  const src = [t.name, t.description, t.end_date, t.start_date, t.priority,
    t.status?.name ?? t.status, t.completed_time, t.tasklist?.name]
    .map((v) => String(v ?? "")).join("\u0000");
  let h = 2166136261;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0; // stays far below any real epoch, so the two can be told apart
}
// Epoch milliseconds passed this in 2001, and a fingerprint is a 32-bit
// unsigned int, so it never can. Anything under it is a fingerprint, and a
// fingerprint must never be compared against a clock to decide who is newer.
const MIN_REAL_EPOCH_MS = 1e12;

// When the work was finished. The Accountability Dashboard counts completions
// by the DATE in completed_at, not by status (accountability_weeks buckets on
// it), so a task can read done on the task list and still score zero for the
// week. 1489 done rows have no completion date at all, which is the "Traction
// is finished and the dashboard says it isn't" complaint exactly.
function zohoCompletedIso(t: any): string | null {
  let ms: number | null = null;
  for (const v of [t.completed_time_long, t.closed_time_long]) {
    if (v != null && v !== "" && !isNaN(Number(v))) { ms = Number(v); break; }
  }
  if (ms == null) {
    for (const v of [t.completed_time, t.closed_time]) {
      if (v) { const p = Date.parse(String(v)); if (!isNaN(p)) { ms = p; break; } }
    }
  }
  return ms ? new Date(ms).toISOString() : null;
}

// Who Zoho says the task belongs to. Zoho nests these under details.owners on
// a list_tasks response and some endpoints repeat the array at the top level,
// so read both. Email is the dependable join to a TMG profile but is not
// always on the payload, hence the id (resolvable through the portal roster
// this file already caches) and the name behind it as a last resort.
type ZOwner = { id: string; name: string; email: string };
function zohoOwners(t: any): ZOwner[] {
  const raw = (t.details?.owners ?? t.owners ?? []) as any[];
  return raw
    .map((o) => ({
      id: o.id_string || (o.id != null ? String(o.id) : (o.zpuid != null ? String(o.zpuid) : "")),
      name: String(o.full_name || o.name || "").trim(),
      email: String(o.email || "").toLowerCase().trim(),
    }))
    .filter((o) => o.id || o.name || o.email);
}

// ── Zoho's text is markup, not display text ───────────────────────────────
// Zoho hands back tasklist names HTML-ESCAPED, and this file stored what it
// was given: the portal's "Gustavo ( Finance Controller & Bookkeeper)" arrives
// as "... &amp; ..." and renders with the escape still in it everywhere TMG
// shows the name. Nothing downstream un-escapes it, so it has to happen here,
// or the backfill migration's repair is undone by the next poll five minutes
// later.
// The scope is narrow because it was checked against the live table rather
// than assumed. Tasklist names are escaped: the one name in the portal holding
// an ampersand holds it as "&amp;". Task titles are NOT: 275 of them hold a
// bare "&" and not one holds an entity. Descriptions must not be touched at
// all, because Zoho sends them as whole HTML documents (2163 of them contain
// tags), where "&amp;" is correct markup and decoding "&lt;" would turn text
// into tags.
const NAMED_ENTITIES: Record<string, string> = {
  "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'",
  // A non-breaking space is invisibly different from a space on screen and
  // silently breaks name matching, so it decodes to the plain one.
  "&nbsp;": " ",
};
// A number that is not a character is not an entity: hand back the literal
// text rather than throwing the whole pull over one badly typed list name.
function entityChar(n: number, raw: string): string {
  const ok = Number.isInteger(n) && n > 0 && n <= 0x10FFFF && (n < 0xD800 || n > 0xDFFF);
  return ok ? String.fromCodePoint(n) : raw;
}
// Ampersand is decoded LAST, or "&amp;lt;" would decode two steps in one pass
// and come out as "<". Same order, and for the same reason, as section 1 of
// the backfill migration.
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (raw, h) => entityChar(parseInt(h, 16), raw))
    .replace(/&#(\d+);/g, (raw, n) => entityChar(Number(n), raw))
    .replace(/&(?:lt|gt|quot|apos|nbsp);/g, (m) => NAMED_ENTITIES[m] ?? m)
    .replace(/&amp;/g, "&");
}

// tasklist_id/name: display-only grouping (e.g. "Pre-List", "Clear to
// Close"), not part of the narrow field-sync scope, but rides along on
// every task object already so no extra API call is needed.
function mapZohoTask(t: any) {
  return {
    id: t.id_string || String(t.id),
    title: t.name || "",
    description: t.description || null,
    due_at: zohoDateToIso(t.end_date),
    // Zoho's own MM-DD-YYYY string, never written to TMG, kept only so a
    // push-back that writes end_date can re-send the start date Zoho already
    // has. Zoho treats start_date as a companion of end_date and invents one
    // (the due date) when it's missing, which reads as a false one-day task.
    start_date: t.start_date || null,
    priority: zohoPriorityToTmg(t.priority),
    status: zohoStatusToTmg(t.status?.name || t.status),
    last_modified_time: zohoModifiedMs(t) ?? zohoFingerprint(t),
    completed_at: zohoCompletedIso(t),
    owners: zohoOwners(t),
    tasklist_id: t.tasklist?.id_string || (t.tasklist?.id != null ? String(t.tasklist.id) : null),
    // decodeEntities, not raw: Zoho escapes this one field and TMG shows it.
    tasklist_name: t.tasklist?.name ? decodeEntities(String(t.tasklist.name)).trim() : null,
  };
}

// Zoho's own completion time whenever it gives one. When it does not, stamp
// now() only on the TRANSITION into done, because that run is the first moment
// TMG could know. Never stamp a task that arrives ALREADY finished: that is
// history, and dating it today would credit month-old work to this week and
// rewrite the scorecard the dashboard is there to report. And clear it when
// Zoho reopens a task, or the task keeps scoring a completion it no longer has.
function completionFor(zt: any, local: any | null): string | null {
  if (zt.status !== "done") return null;
  if (zt.completed_at) return zt.completed_at;
  if (local?.completed_at) return local.completed_at;
  return local && local.status !== "done" ? new Date().toISOString() : null;
}

// ── Zoho owner ids from TMG emails ────────────────────────────────────────
// Same shape as zoho-projects' resolveZohoOwnerIds, and deliberately reading
// the SAME cache column on zoho_projects_connection, so the two functions warm
// each other rather than each burning a /users/ call. A task pushed without
// person_responsible lands unassigned in Zoho, which is exactly the useless
// state the Accountability Dashboard was already in, so this is not optional.
const PORTAL_USERS_TTL_MS = 6 * 60 * 60 * 1000;
// The roster itself, email -> Zoho user id. Split out from zohoOwnerIds
// because the two directions of the sync want it the two different ways round:
// the push knows a TMG email and needs Zoho's id, the pull gets Zoho's id off
// a task and needs the email to find the person in TMG. One cache answers
// both, so adding owners to the pull costs no extra /users/ call.
async function portalUsersCache(
  sb: any, conn: any, zFetch: (u: string, i?: RequestInit) => Promise<Response>,
  portalBase: string, wanted: string[] = [],
): Promise<Record<string, string>> {
  let cache = (conn.portal_users_cache || {}) as Record<string, string>;
  const cachedAt = conn.portal_users_cached_at ? Date.parse(conn.portal_users_cached_at) : 0;
  const stale = !cachedAt || (Date.now() - cachedAt) > PORTAL_USERS_TTL_MS;
  if (stale || wanted.some((e) => !cache[e])) {
    const r = await zFetch(`${portalBase}/users/`);
    const d = await r.json().catch(() => ({}));
    if (r.ok) {
      const fresh: Record<string, string> = {};
      for (const u of (d.users || d.userlist || [])) {
        const email = (u.email || "").toLowerCase().trim();
        const id = u.id_string || (u.id != null ? String(u.id) : "");
        if (email && id) fresh[email] = id;
      }
      cache = fresh;
      conn.portal_users_cache = fresh;
      conn.portal_users_cached_at = new Date().toISOString();
      try {
        await sb.from("zoho_projects_connection")
          .update({ portal_users_cache: fresh, portal_users_cached_at: conn.portal_users_cached_at })
          .eq("refresh_token", conn.refresh_token);
      } catch (_) { /* cache write is best-effort */ }
    }
  }
  return cache;
}
async function zohoOwnerIds(
  sb: any, conn: any, zFetch: (u: string, i?: RequestInit) => Promise<Response>,
  portalBase: string, emails: string[],
): Promise<string[]> {
  const wanted = emails.map((e) => (e || "").toLowerCase().trim()).filter(Boolean);
  if (!wanted.length) return [];
  const cache = await portalUsersCache(sb, conn, zFetch, portalBase, wanted);
  return wanted.map((e) => cache[e]).filter(Boolean);
}

// ── Which tasklist belongs to which person ────────────────────────────────
// Zoho's per-person tasklists are named freehand ("Alexa (TC)", "Symon
// (O.M.)", "Gustavo ( Finance Controller & Bookkeeper)"), so the LEADING word
// is the only part that names anybody. What follows it can name someone else
// entirely: "Luciana (E.A. to Tarek)" is Luciana's list, not Tarek's, and
// matching the whole string files her work under him. Same two helpers as
// tasks.jsx's memberForTasklistName, duplicated by the convention above so the
// browser and this job never disagree about whose list is whose.
function leadWord(str: string | null | undefined): string {
  return (str || "").toLowerCase().replace(/[^a-z]+/g, " ").trim().split(" ")[0] || "";
}
// Either side may be the short form of the other ("Alexa" / "Alexandra"), and
// three letters is the floor because two would match half the team.
function leadWordHit(a: string, b: string): boolean {
  return a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a));
}

// ── Zoho task owners to TMG profiles ──────────────────────────────────────
// accountability_weeks counts a person's work strictly through task_people
// (it joins role = 'assignee'), so a task imported with nobody on it is not
// merely unattributed, it is invisible to the dashboard. 2804 of the 2810
// imported rows have no assignee row at all, and that is the whole of "for
// Gustavo I can only see one task". Built once per run and memoised, because
// both rosters behind it are the same for every task in the run.
function ownerResolver(
  sb: any, conn: any, zFetch: (u: string, i?: RequestInit) => Promise<Response>, portalBase: string,
) {
  let people: any[] | null = null;
  let emailForZohoId: Record<string, string> | null = null;

  const loadPeople = async () => {
    if (!people) {
      const { data } = await sb.from("profiles").select("id,email,first_name,status");
      people = (data || []).filter((p: any) => !p.status || p.status === "active");
    }
    return people!;
  };
  const loadPortalIds = async () => {
    if (!emailForZohoId) {
      const cache = await portalUsersCache(sb, conn, zFetch, portalBase);
      emailForZohoId = {};
      for (const [email, id] of Object.entries(cache)) emailForZohoId[id] = email;
    }
    return emailForZohoId!;
  };

  // Returns the TMG profile ids AND whether every Zoho owner was placed. The
  // caller needs that second answer before it removes anybody: an owner this
  // code cannot place (Luciana holds a Zoho tasklist and has no profiles row
  // at all) must never be read as "Zoho says this person is off the task".
  return async (owners: ZOwner[]): Promise<{ ids: string[]; complete: boolean }> => {
    if (!owners.length) return { ids: [], complete: false };
    const roster = await loadPeople();
    const ids = new Set<string>();
    let unplaced = 0;
    for (const o of owners) {
      let email = o.email;
      if (!email && o.id) email = (await loadPortalIds())[o.id] || "";
      let hit = email
        ? roster.find((p: any) => String(p.email || "").toLowerCase().trim() === email)
        : null;
      if (!hit && o.name) {
        // Same leading-word rule the tasklist routing uses, for the same
        // reason: "Gustavo ( Finance Controller & Bookkeeper)" and "Alexa"
        // against "Alexandra" are the shapes real names arrive in here. Only
        // an unambiguous single hit counts, because filing one person's work
        // under another is worse than filing it under nobody.
        const w = leadWord(o.name);
        const hits = roster.filter((p: any) => leadWordHit(w, leadWord(p.first_name || p.email)));
        if (hits.length === 1) hit = hits[0];
      }
      if (hit) ids.add(hit.id); else unplaced++;
    }
    return { ids: Array.from(ids), complete: unplaced === 0 };
  };
}

// Upsert, never delete-then-insert: assigned_at is the column
// accountability_weeks buckets the "assigned" count by, so re-inserting a row
// that already exists would re-date somebody's whole history into this week.
//
// Adding is eager and removing is not, and that asymmetry is deliberate. The
// Zoho owner field is read through a list of candidate names (see zohoOwners)
// and not one of them is confirmed against the live portal, so every answer it
// gives is a guess. The two guesses cost very different things: a wrong ADD
// leaves one name too many on a task, which anybody can see and undo, while a
// wrong REMOVE erases the only record that a person ever held the work, and
// accountability_weeks stops counting it with nothing on screen to say why.
//
// removalEpochMs is the higher bar. The caller passes Zoho's own modified time,
// and only when it is a real clock reading rather than the content fingerprint,
// on a task TMG has stamped before. A person then comes off only if that Zoho
// edit is NEWER than the moment they were put on here, because an assignment
// made in TMG after Zoho last changed cannot be something that Zoho change took
// away. So the first catch-up run removes nobody at all: nothing has ever been
// stamped, which is the right posture for a run that rewrites 2810 rows at once.
async function applyAssignees(
  sb: any, taskId: string, createdAt: string | null, ids: string[], complete: boolean,
  removalEpochMs: number | null = null,
) {
  if (!ids.length) return;
  await sb.from("task_people").upsert(
    // Dated from the task, not from now(): a task Zoho has had since August is
    // not work assigned this afternoon, and dating it today would credit it to
    // the current week. Same convention as 20260910120000_accountability_weeks.
    ids.map((user_id) => ({
      task_id: taskId, user_id, role: "assignee",
      assigned_at: createdAt || new Date().toISOString(),
    })),
    { onConflict: "task_id,user_id,role", ignoreDuplicates: true },
  );
  // A lookup miss is still not a statement that somebody was removed, so
  // `complete` remains a precondition exactly as it was.
  if (!complete || removalEpochMs == null) return;
  const { data: existing } = await sb.from("task_people")
    .select("user_id,assigned_at").eq("task_id", taskId).eq("role", "assignee");
  const stale = (existing || []).filter((r: any) => {
    if (ids.includes(r.user_id)) return false;
    // No assignment date is no basis either: it would read as the epoch, which
    // makes every Zoho edit look newer and takes the row off on sight.
    const at = r.assigned_at ? new Date(r.assigned_at).getTime() : NaN;
    return !isNaN(at) && removalEpochMs > at + CLOCK_SKEW_MS;
  });
  if (!stale.length) return;
  const userIds = stale.map((r: any) => r.user_id);
  await sb.from("task_people").delete()
    .eq("task_id", taskId).eq("role", "assignee").in("user_id", userIds);
  // Every other change this file makes leaves a line on the task. A removed
  // assignee left none, so the one person who needed to know had no way to find
  // out. Named, so it can be put back where it belongs.
  const { data: who } = await sb.from("profiles").select("id,first_name,email").in("id", userIds);
  const names = (who || []).map((p: any) => p.first_name || p.email).filter(Boolean);
  await sb.from("task_activity").insert({
    task_id: taskId, kind: "system",
    content: names.length
      ? `Taken off this task in Zoho Projects: ${names.join(", ")}. Zoho is where that came from, so put them back there if it is wrong.`
      : "An assignee was taken off this task in Zoho Projects.",
  });
}

// Does this task already have somebody on it here? One narrow read, asked only
// on the path that is about to guess an owner from a tasklist NAME, so a
// project filed by phase and a task Zoho named an owner for never pay for it.
async function hasAssignee(sb: any, taskId: string): Promise<boolean> {
  const { data } = await sb.from("task_people")
    .select("user_id").eq("task_id", taskId).eq("role", "assignee").limit(1);
  return !!(data && data.length);
}

type ZTasklist = { id: string; name: string };

// The project's lists as Zoho has them, not as the already-synced rows imply:
// a list made for someone this morning has no local rows yet, and that person
// is precisely the one whose work gets misfiled. Same endpoint and response
// shape as zoho-projects' list_tasklists action, which has been reading
// { tasklists: [{ id_string, name }] } from the live portal since August.
// Returns null (not []) when Zoho would not answer, so the caller can tell
// "this project has no lists" from "we do not know yet" and hold off.
async function fetchProjectTasklists(
  zFetch: (u: string, i?: RequestInit) => Promise<Response>,
  portalBase: string, zohoProjectId: string,
): Promise<ZTasklist[] | null> {
  const read = async (url: string) => {
    const r = await zFetch(url);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    return ((d.tasklists || []) as any[])
      .map((t) => ({ id: t.id_string || (t.id != null ? String(t.id) : ""), name: t.name ? String(t.name).trim() : "" }))
      .filter((t) => t.id);
  };
  const base = `${portalBase}/projects/${zohoProjectId}/tasklists/`;
  // The unparameterised call is the one already proven against the live
  // portal, so it stays the normal path. Zoho pages this endpoint at 100 and
  // says nothing about there being more, so a full page is the only hint that
  // there is; nobody here is near 100 lists, and each extra page is another
  // call against the ceiling, so paging stays the exception.
  const first = await read(base);
  if (!first || first.length < 100) return first;
  const all = first.slice();
  for (let page = 1; page < 5; page++) {
    const more = await read(`${base}?index=${page * 100 + 1}&range=100`);
    if (!more || !more.length) break;
    all.push(...more);
    if (more.length < 100) break;
  }
  return all;
}

// Zoho pages this endpoint and says nothing about there being more, so a full
// page is the only hint that there is one. The old call took the default page
// size and read page one only, which is why 23 of the 30 linked projects sit
// at exactly 100 local tasks and not one sits above it: every one of them has
// been silently losing its tail. range=200 is the page size
// count_tasks_by_tasklist in zoho-projects already runs against this portal.
const TASK_PAGE = 200;
const MAX_TASK_PAGES_PER_RUN = 60;
async function fetchProjectTasks(
  zFetch: (u: string, i?: RequestInit) => Promise<Response>,
  portalBase: string, zohoProjectId: string, sinceMs: number | null, budget: number,
): Promise<{ tasks: any[]; pagesUsed: number; error: string | null; truncated: boolean }> {
  const all: any[] = [];
  let index = 1, pagesUsed = 0;
  while (pagesUsed < budget) {
    const u = new URL(`${portalBase}/projects/${zohoProjectId}/tasks/`);
    if (sinceMs != null) u.searchParams.set("last_modified_time", String(sinceMs));
    u.searchParams.set("index", String(index));
    u.searchParams.set("range", String(TASK_PAGE));
    const r = await zFetch(u.toString());
    const d = await r.json().catch(() => ({}));
    pagesUsed++;
    if (!r.ok) return { tasks: all, pagesUsed, error: d?.error || `HTTP ${r.status}`, truncated: false };
    const batch = (d.tasks || []) as any[];
    all.push(...batch);
    if (batch.length < TASK_PAGE) return { tasks: all, pagesUsed, error: null, truncated: false };
    index += TASK_PAGE;
  }
  // Out of page budget with a full page behind us. The rest of this project
  // arrives next tick and nothing is dropped, because a project is only let
  // off the full read once none of its tasks is missing a Zoho timestamp.
  return { tasks: all, pagesUsed, error: null, truncated: true };
}

// The tasklist a task belongs in, or null when no list matches the person.
// Null is an answer, not a failure: on a per-person project the caller must
// NOT fall back to the project default, because that default is one person's
// list and filing everyone else's work in it is the bug this exists to stop.
function tasklistForNames(names: string[], lists: ZTasklist[], counts: Record<string, number>): string | null {
  // Zoho files a task in exactly one list, so a task on two people still has
  // to pick one. Alphabetical by first name, so a retry lands where the
  // previous attempt would have; everyone on it still gets person_responsible.
  const ordered = names.map(leadWord).filter((n) => n.length >= 3).sort();
  for (const n of ordered) {
    const hits = lists.filter((l) => leadWordHit(leadWord(l.name), n));
    // One person with two lists ("Symon (O.M.)" and "Symon 2") is normal and
    // the busier one is the live one. The id tiebreak stops the answer
    // wobbling from run to run when the counts are level.
    if (hits.length) return hits.sort((a, b) => ((counts[b.id] || 0) - (counts[a.id] || 0)) || (a.id < b.id ? -1 : 1))[0].id;
  }
  return null;
}

// ── Is this project filed by person, or by phase? ─────────────────────────
// Two shapes reach this job and only one of them wants routing. An ordinary
// CTC file names its lists after the stages of a deal ("Pre-List", "Option
// Period", "Marketing Maintenance", "Clear to Close"), and every task on it
// belongs in the project default, which is where they have always gone.
// "Accountabilities" names its lists after PEOPLE, and there the default is
// one person's list, so filing by assignee is the only right answer.
//
// So the question is what the lists are NAMED, never how many there are: most
// CTC files carry four or five phase lists, and reading "more than one list"
// as "per person" would strand every task on the owner's most-used record.
//
// The test is at least TWO DISTINCT PEOPLE holding a list of their own.
//   - One is not enough. A phase name can hit a real first name by accident
//     (a "Marketing Maintenance" list and a team member called Mark would
//     match), and a project with a single list is the ordinary case that has
//     nothing to route anyway.
//   - It counts PEOPLE, not matching lists, because one person often keeps
//     two ("Symon (O.M.)" and "Symon 2"); counting lists would score a
//     project with a single real person on it as two.
// Each list resolves to at most ONE person, so a single list can never reach
// the threshold on its own, not even when two team names both read as a
// prefix of it ("Alexa" and "Alexandra").
function distinctPeopleWithLists(lists: ZTasklist[], teamNames: string[]): number {
  const team = Array.from(new Set(teamNames.map(leadWord).filter((n) => n.length >= 3))).sort();
  const people = new Set<string>();
  for (const l of lists) {
    const w = leadWord(l.name);
    if (w.length < 3) continue;
    const who = team.find((m) => leadWordHit(w, m));
    if (who) people.add(who);
  }
  return people.size;
}

// Whose list is this? Exactly one active profile, or nobody. Same leading-word
// rule as everything else here, and the same answer to ambiguity that
// 20260924140000 gives: two possible people means nobody, because filing one
// person's work under another is worse than leaving it unfiled.
function profileForTasklistName(name: string | null, roster: { id: string; name: string }[]): string | null {
  const w = leadWord(name);
  if (w.length < 3) return null;
  const hits = roster.filter((p) => leadWordHit(w, leadWord(p.name)));
  return hits.length === 1 ? hits[0].id : null;
}

// ── Recording an overwrite this job cannot justify ────────────────────────
// The plain-pull branch takes Zoho's values whenever it cannot prove TMG's are
// newer. Zoho winning stays the policy; what was missing is any trace of it.
// A title typed here at 9:00 and replaced by the 9:05 poll left no conflict
// row and no activity line, so the person who lost the edit had nothing at all
// to look at, and no way to tell an overwrite from their own mistake.
const SYNCED_FIELDS = ["title", "description", "due_at", "priority", "status"];
const FIELD_LABEL: Record<string, string> = {
  title: "Title", description: "Description", due_at: "Due date",
  priority: "Priority", status: "Status",
};
// Short on purpose: a description runs to thousands of characters, and this
// line is meant to be read on the task, not scrolled through.
function shortValue(field: string, v: unknown): string {
  if (v == null || v === "") return "(empty)";
  if (field === "due_at") return shortDate(String(v)) || String(v);
  const str = String(v);
  return str.length > 120 ? str.slice(0, 117) + "..." : str;
}
// due_at is the one synced field that holds a MOMENT rather than text, and the
// two sides spell the same moment differently (see sameMoment), so comparing
// it as text reported an overwrite on every dated task that had not changed.
// The other four are plain text on both sides, where text comparison is right.
function overwrittenFields(local: any, zt: any): string[] {
  return SYNCED_FIELDS.filter((f) => f === "due_at"
    ? !sameMoment(local[f], zt[f])
    : (local[f] || null) !== (zt[f] || null));
}
// Plain register, like every other line this file writes, and it says the one
// thing the reader needs: their edit is gone, this is what replaced it, and
// nothing here could tell which of the two came first.
function unverifiedOverwriteLine(local: any, zt: any, fields: string[], neverStamped: boolean): string {
  const why = neverStamped
    ? "TMG has never held a modified time for this task"
    : "Zoho sent no modified time for this task";
  const f = fields[0];
  const rest = fields.slice(1).map((x) => FIELD_LABEL[x].toLowerCase());
  return `Edited here and in Zoho Projects since the last sync, and ${why}, so there is no telling which edit came last. Zoho's version was kept. ${FIELD_LABEL[f]} was "${shortValue(f, local[f])}" here and is now "${shortValue(f, zt[f])}".`
    + (rest.length ? ` Also replaced: ${rest.join(", ")}.` : "");
}

// Said once per task, never once per tick: this job runs every 5 minutes and
// an unroutable task stays unroutable until a person fixes it, so an unguarded
// insert would bury the task's own history under the same line 288 times a day.
const UNROUTED_NOTE_PREFIX = "Not sent to Zoho Projects yet";
async function noteUnrouted(sb: any, taskId: string, projectName: string, names: string[]) {
  const { data: already } = await sb.from("task_activity")
    .select("id").eq("task_id", taskId).eq("kind", "system")
    .ilike("content", `${UNROUTED_NOTE_PREFIX}%`).limit(1);
  if (already?.length) return;
  // Two different problems, so two different sentences. A task with nobody on
  // it is not waiting for a tasklist to appear, it is waiting for a person, so
  // telling the reader to wait would send them to Zoho for something only they
  // can fix here.
  const why = names.length
    ? `${projectName} keeps a separate Zoho tasklist for each person, and there isn't one there for ${names.join(", ")}. It goes over on its own once that list exists.`
    : `${projectName} keeps a separate Zoho tasklist for each person, and nobody is assigned to this task, so there is no list to file it in. Give it an assignee and it goes over on the next run.`;
  await sb.from("task_activity").insert({
    task_id: taskId, kind: "system", content: `${UNROUTED_NOTE_PREFIX}: ${why}`,
  });
}

// Zoho Projects allows 100 calls / 2 min per token and this job runs every
// 5 min, so a first run over a long-neglected project must not try to create
// everything at once. Whatever does not fit goes on the next tick; the cap is
// per project so one busy project cannot starve the others.
const MAX_PUSH_PER_PROJECT = 10;
const MAX_PUSH_PER_RUN = 40;
// The conflict branch below can also write to Zoho, one call per task, and
// nothing used to cap it. With the change detector repaired the first
// catch-up run sees thousands of tasks at once, so it needs the same kind of
// ceiling the create path has had: whatever does not fit goes on the next tick.
const MAX_CONFLICT_PUSH_PER_RUN = 20;
// The insert that creates a task stamps zoho_last_synced_at from JS a few
// milliseconds before Postgres evaluates now() for updated_at, so 2804 of 2806
// rows read as "edited in TMG since the last sync" when nobody had touched
// them (average skew 0.379s, only 2 rows over two seconds). Two seconds of
// slack is far below any real human edit and removes every false positive.
const CLOCK_SKEW_MS = 2000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const secret = Deno.env.get("ZOHO_POLL_CRON_SECRET") || "";
  const auth = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!secret || auth !== secret) return json({ error: "unauthorized" }, 401);

  const sb = serviceClient();
  if (!sb) return json({ error: "server not configured" }, 500);

  const { data: conn } = await sb.from("zoho_projects_connection").select("*").limit(1).single();
  if (!conn?.refresh_token || !conn?.portal_id) return json({ error: "Zoho Projects not connected" }, 200);

  let accessToken: string;
  try { accessToken = await getZohoToken(sb, conn); }
  catch (e) { return json({ error: "Could not mint Zoho token: " + String((e as any)?.message || e) }, 200); }

  const apiDomain = conn.api_domain || "projectsapi.zoho.com";
  const portalBase = `https://${apiDomain}/restapi/portal/${conn.portal_id}`;
  const zFetch = (url: string, init: RequestInit = {}) =>
    fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: "Zoho-oauthtoken " + accessToken } });

  // Only opted-in CTC files + regular Projects (e.g. "Accountability"), one
  // list_tasks call each (plan §4 rate-limit design). Rocks excluded, matches
  // ZOHO_SYNCABLE_KINDS in tasks.html.
  const { data: projects } = await sb
    .from("projects")
    .select("id,name,zoho_project_id,zoho_tasklist_id,zoho_last_synced_at")
    .in("record_type", ["ctc_file", "project"])
    .eq("zoho_sync_enabled", true)
    .eq("archived", false)
    .not("zoho_project_id", "is", null);

  const summary: any[] = [];
  let pushedThisRun = 0;
  let conflictPushesThisRun = 0;
  let taskPageBudget = MAX_TASK_PAGES_PER_RUN;
  const resolveOwners = ownerResolver(sb, conn, zFetch, portalBase);

  // The team, read once per run and only when some project actually needs it.
  // It is a Postgres read, not a Zoho call, so it costs nothing against the
  // rate limit. Active only, and first name only, matching what tasks.jsx
  // hands memberForTasklistName. An empty roster simply means no project can
  // look per-person, so everything keeps the project default.
  //
  // Kept as id + name rather than name alone because two callers want it two
  // ways: the per-person project test asks which names hold a list, and the
  // owner fallback below needs the profile behind the name it matched.
  let roster: { id: string; name: string }[] | null = null;
  const loadRoster = async (): Promise<{ id: string; name: string }[]> => {
    if (roster) return roster;
    const { data: team } = await sb.from("profiles").select("id,first_name,email,status");
    roster = (team || [])
      .filter((p: any) => !p.status || p.status === "active")
      .map((p: any) => ({
        id: p.id,
        name: String(p.first_name || "").trim() || String(p.email || "").split("@")[0],
      }))
      .filter((p: any) => p.name);
    return roster;
  };
  const loadTeamNames = async (): Promise<string[]> => (await loadRoster()).map((p) => p.name);

  for (const proj of projects || []) {
    try {
      // An incremental cursor is only honest once TMG actually holds Zoho's
      // state, and until this change no pull had ever written an owner, a
      // completion date, or even a readable modified timestamp, so every row
      // imported before now is a shell. Asking Zoho for "just what changed
      // since the last tick" would leave those shells empty until somebody
      // happened to touch each one in Zoho again. So a project with any task
      // still missing its Zoho timestamp is read in full, and it drops back to
      // the cheap incremental read by itself, per project, once the last shell
      // has been filled. No flag to set and none to remember to clear.
      const { data: shell } = await sb.from("tasks").select("id")
        .eq("project_id", proj.id).not("zoho_task_id", "is", null)
        .is("zoho_last_modified_time", null).limit(1);
      const fullRead = !proj.zoho_last_synced_at || !!shell?.length;
      // Zoho validates last_modified_time by NAME and then wants epoch
      // milliseconds. zoho_last_synced_at is a timestamptz, so it went over as
      // an ISO string and Zoho answered 403 "Data type mismatch" for every
      // project on every tick from 2026-09-07 on. The `continue` below then
      // skipped the zoho_last_synced_at stamp at the end of this loop, so the
      // same bad value went out again five minutes later: a deadlock rather
      // than a flaky call, and the reason nothing in this file had run since.
      const sinceRaw = fullRead ? NaN : Date.parse(proj.zoho_last_synced_at);
      const page = await fetchProjectTasks(
        zFetch, portalBase, proj.zoho_project_id, isNaN(sinceRaw) ? null : sinceRaw, taskPageBudget,
      );
      taskPageBudget -= page.pagesUsed;
      if (page.error) { summary.push({ project: proj.name, error: page.error }); continue; }

      const zTasks = page.tasks.map(mapZohoTask);
      let pulled = 0, conflicts = 0, created = 0, conflictDeferred = 0, unverified = 0;
      let conflictRowsRejected = 0, conflictRejectWhy = "";

      // Read at most once per project per run, and only when something
      // actually needs routing, because every read is another call against the
      // 100-per-2-min ceiling. The same read answers the shape question once
      // for the whole project (per person, or the usual phase lists). The
      // counts are local rows and only ever break a tie between two lists
      // belonging to the same person.
      let tasklists: ZTasklist[] | null = null;
      let tasklistsRead = false;
      let perPerson = false;
      const tasklistCounts: Record<string, number> = {};
      const loadTasklists = async () => {
        if (tasklistsRead) return tasklists;
        tasklistsRead = true;
        tasklists = await fetchProjectTasklists(zFetch, portalBase, proj.zoho_project_id);
        if (tasklists) {
          perPerson = distinctPeopleWithLists(tasklists, await loadTeamNames()) >= 2;
          const { data: placed } = await sb.from("tasks")
            .select("zoho_tasklist_id").eq("project_id", proj.id).not("zoho_tasklist_id", "is", null);
          for (const row of placed || []) {
            const k = (row as any).zoho_tasklist_id;
            if (k) tasklistCounts[k] = (tasklistCounts[k] || 0) + 1;
          }
        }
        return tasklists;
      };

      // Zoho's owner field is a guess (see zohoOwners), and when it answers
      // nobody the tasklist the task sits in is the second source this project
      // already trusts: Accountabilities files one list per person, which is
      // how 20260924140000 recovered 18 assignees with no Zoho owner at all.
      // Without this the permanent code is worse than the one-time repair, and
      // every task imported from now on lands with nobody on it.
      //
      // Only on a project whose lists are named after PEOPLE, decided by the
      // same test the push path uses: an ordinary CTC file's lists are deal
      // phases ("Pre-List", "Clear to Close") and matching those would invent
      // owners rather than recover them.
      const ownerFromTasklist = async (tasklistName: string | null): Promise<string[]> => {
        if (!tasklistName) return [];
        // The name test comes first and the Zoho read second, so a phase-named
        // project answers here and never spends a call against the
        // 100-per-2-min ceiling. An ambiguous name settles here too, as nobody.
        const id = profileForTasklistName(tasklistName, await loadRoster());
        if (!id) return [];
        // A list that reads like a person is not yet a per-person project: one
        // phase name can hit a real first name by accident. Ask Zoho what the
        // project's lists really are and apply the two-distinct-people test,
        // on the same single read the push path will reuse.
        const lists = await loadTasklists();
        return lists && perPerson ? [id] : [];
      };

      for (const zt of zTasks) {
        const { data: local } = await sb.from("tasks").select("*")
          .eq("project_id", proj.id).eq("zoho_task_id", zt.id).maybeSingle();

        const owned = await resolveOwners(zt.owners);
        // Nobody came back from Zoho's owner field, so ask the tasklist. A
        // list name is a RECOVERY for a task nobody owns, never a correction
        // of an assignment a person made here. "Resolve TMG Duplicate Client
        // Folders" is assigned to Alexandra and sits in the "Tarek" list only
        // because of the default-tasklist bug the push path now fixes, so
        // reading the list name there would put Tarek on the task ALONGSIDE
        // her and accountability_weeks would credit the work to both. It would
        // recur every time somebody reassigns a task here without also moving
        // the Zoho list. The one-time backfill (20260924140000) carries this
        // same guard; this is the permanent version of it. A name off Zoho's
        // own owner field is a different claim and keeps its behaviour.
        let assigneeIds = owned.ids;
        if (!assigneeIds.length) {
          const fromList = await ownerFromTasklist(zt.tasklist_name);
          // The read only happens once the list has actually named somebody,
          // and a row about to be inserted trivially has nobody on it yet.
          if (fromList.length && (!local || !(await hasAssignee(sb, local.id)))) {
            assigneeIds = fromList;
          }
        }
        // A fingerprint is not a clock (see MIN_REAL_EPOCH_MS), and only a
        // clock can support the claim that somebody was taken off a task.
        const zohoEpochMs = (zt.last_modified_time || 0) >= MIN_REAL_EPOCH_MS ? zt.last_modified_time : null;

        if (!local) {
          // A task created directly in Zoho, so mirror it into TMG.
          const { data: inserted } = await sb.from("tasks").insert({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status, project_id: proj.id,
            completed_at: completionFor(zt, null),
            zoho_task_id: zt.id, zoho_last_synced_at: new Date().toISOString(),
            zoho_last_modified_time: zt.last_modified_time,
            zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
          }).select().single();
          if (inserted) {
            // No removalEpochMs: a row created a line ago has nobody on it yet.
            await applyAssignees(sb, inserted.id, inserted.created_at, assigneeIds, owned.complete);
            await sb.from("task_activity").insert({ task_id: inserted.id, kind: "system", content: "Task created in Zoho Projects" });
            created++;
          }
          continue;
        }

        // A stored null does NOT mean the two sides agree, it means TMG has
        // never held a Zoho timestamp for this task: null !== null is false,
        // so the old test read all 2810 imported rows as unchanged and skipped
        // every one of them, forever. Treat no-stored-timestamp as CHANGED. It
        // costs one extra update the first time and then settles, and erring
        // toward an extra update is the right way round to be wrong.
        const neverStamped = local.zoho_last_modified_time == null;

        // Ownership is applied on every pass, ahead of the change test rather
        // than inside it, because it was never written before this change: the
        // rows that need an assignee most are precisely the ones Zoho has
        // nothing new to say about, and gating them on a change would leave
        // them empty for as long as nobody edits them.
        await applyAssignees(
          sb, local.id, local.created_at, assigneeIds, owned.complete,
          neverStamped ? null : zohoEpochMs,
        );

        const localChangedSinceSync = local.updated_at && local.zoho_last_synced_at
          ? new Date(local.updated_at).getTime() > new Date(local.zoho_last_synced_at).getTime() + CLOCK_SKEW_MS
          : !local.zoho_last_synced_at; // never synced before = treat as "changed" so first sync isn't lost
        const zohoChangedSinceSync = neverStamped || zt.last_modified_time !== local.zoho_last_modified_time;

        if (!zohoChangedSinceSync) continue; // Zoho has nothing new for this task this cycle

        // When TMG has never held a Zoho timestamp there is no basis for the
        // claim that TMG is the newer side, and the conflict branch answers
        // that claim by POSTing TMG's values over Zoho's. "Reading Assignment:
        // Traction" is todo here and Closed in Zoho, so that push would reopen
        // the finished task in the very complaint this change exists to fix,
        // and 1489 rows are stale in the same direction. Holding the catch-up
        // to Zoho-wins makes it read-only by construction, not by good luck.
        // The third condition is the fingerprint guard: when Zoho gave no
        // real timestamp, TMG is holding a content hash, and a hash cannot
        // establish who edited last. Comparing one against a clock would make
        // TMG win every single time and push its values over Zoho's. Without
        // provable recency the read-only branch is the only honest answer.
        const provableTime = zohoEpochMs != null;
        if (localChangedSinceSync && !neverStamped && provableTime) {
          // Both sides changed since the last successful sync: a real conflict.
          // Last-write-wins by timestamp (confirmed v1 rule, logged either way).
          const localMs = local.updated_at ? new Date(local.updated_at).getTime() : 0;
          const zohoMs = zt.last_modified_time || 0;
          const changedField = overwrittenFields(local, zt)[0] || "title";

          if (zohoMs > localMs) {
            await sb.from("tasks").update({
              title: zt.title, description: zt.description, due_at: zt.due_at,
              priority: zt.priority, status: zt.status,
              completed_at: completionFor(zt, local),
              zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
              zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
            }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String(local[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "zoho_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}": Zoho's edit was more recent, so Zoho's value was kept.` });
            const moved = dueDateMovedLine(local.due_at, zt.due_at);
            if (moved) await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: moved, field: "due_at" });
          } else if (conflictPushesThisRun >= MAX_CONFLICT_PUSH_PER_RUN) {
            // Over the per-run ceiling on conflict write-backs. Left entirely
            // alone, sync stamps included, so the next tick finds it in exactly
            // this state and resolves it then. Deferred, never dropped.
            conflictDeferred++;
            continue;
          } else {
            // TMG wins, so push TMG's current values back to Zoho to overwrite its stale edit.
            const form = new URLSearchParams({
              name: local.title || "", description: local.description || "",
              priority: tmgPriorityToZoho(local.priority), status: tmgStatusToZoho(local.status),
            });
            const zd = isoToZohoDate(local.due_at); if (zd) form.set("end_date", zd);
            // Hand Zoho back the start date it already has, so writing the due
            // date can't make it invent one. See mapZohoTask's start_date note.
            if (zd && zt.start_date) form.set("start_date", zt.start_date);
            await zFetch(`${portalBase}/projects/${proj.zoho_project_id}/tasks/${zt.id}/`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form.toString() });
            await sb.from("tasks").update({ zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: Date.now() }).eq("id", local.id);
            await sb.from("zoho_sync_conflicts").insert({ task_id: local.id, project_id: proj.id, field: changedField, tmg_value: String(local[changedField] ?? ""), zoho_value: String((zt as any)[changedField] ?? ""), resolution: "tmg_won" });
            await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: `Zoho sync conflict on "${changedField}": TMG's edit was more recent, so TMG's value was kept and pushed to Zoho.` });
            conflictPushesThisRun++;
          }
          conflicts++;
        } else {
          // Only Zoho changed: plain pull, no conflict. Deliberately does NOT
          // set updated_at, so this pull is never mistaken for a TMG-side edit
          // on the next cycle (which would create a false conflict/ping-pong).
          //
          // Except when localChangedSinceSync is true, which means both sides
          // moved and the branch above could not prove which moved last, so
          // the update below is about to replace a real TMG edit. Zoho winning
          // is the policy and is not what changes here. What changes is that
          // the loss stops being invisible: read the values off the local row
          // before the update overwrites them.
          const overwritten = localChangedSinceSync ? overwrittenFields(local, zt) : [];
          const moved = dueDateMovedLine(local.due_at, zt.due_at);
          await sb.from("tasks").update({
            title: zt.title, description: zt.description, due_at: zt.due_at,
            priority: zt.priority, status: zt.status,
            completed_at: completionFor(zt, local),
            zoho_last_synced_at: new Date().toISOString(), zoho_last_modified_time: zt.last_modified_time,
            zoho_tasklist_id: zt.tasklist_id, zoho_tasklist_name: zt.tasklist_name,
          }).eq("id", local.id);
          if (overwritten.length) {
            // The task line goes first because it is the one a person reads
            // and it depends on nothing. The conflict row needs the widened
            // resolution check from 20260924140000 and is refused by Postgres
            // until that migration lands, which must not cost the line.
            await sb.from("task_activity").insert({
              task_id: local.id, kind: "system", field: overwritten[0],
              content: unverifiedOverwriteLine(local, zt, overwritten, neverStamped),
            });
            // Counted only when the row actually lands. The live CHECK on
            // resolution still allows two values and 20260924140000 is what
            // widens it, so a deploy that lands before that migration has
            // Postgres refusing every one of these inserts. supabase-js hands
            // a refusal back as { error } instead of throwing, so the old
            // count reported overwrites_unverified with not one row behind it
            // for anybody to go and look at.
            const { error: conflictErr } = await sb.from("zoho_sync_conflicts").insert({
              task_id: local.id, project_id: proj.id, field: overwritten[0],
              tmg_value: String(local[overwritten[0]] ?? ""),
              zoho_value: String((zt as any)[overwritten[0]] ?? ""),
              resolution: "zoho_won_unverified",
            });
            if (conflictErr) {
              conflictRowsRejected++;
              // Said once per project, with the reason, so a refused write is
              // something a person can find rather than a silent shortfall.
              if (!conflictRejectWhy) {
                conflictRejectWhy = String((conflictErr as any).message || conflictErr);
                console.warn(JSON.stringify({ zoho_projects_poll_conflict_row_rejected: { project: proj.name, why: conflictRejectWhy } }));
              }
            } else {
              unverified++;
            }
          }
          if (moved) await sb.from("task_activity").insert({ task_id: local.id, kind: "system", content: moved, field: "due_at" });
          pulled++;
        }
      }

      // ── PUSH: TMG tasks Zoho has never seen ─────────────────────────────
      // A task typed into the app is sent to Zoho by the browser (tasks.jsx,
      // the create_task branch). Anything created server-side never passes
      // through that code at all, chiefly the meeting-agenda to-dos that
      // google-tasks-sync imports every 15 minutes. Without this block they
      // sit in the app forever and the Accountability Dashboard stays empty,
      // which is exactly what happened between 2026-09-10 and 2026-09-24.
      let pushed = 0, pushSkipped = 0, unrouted = 0;
      if (!proj.zoho_tasklist_id) {
        // Zoho refuses a task with no tasklist, and guessing one would scatter
        // tasks into a list nobody watches. Surfaced rather than swallowed.
        pushSkipped = -1;
      } else {
        const room = Math.min(MAX_PUSH_PER_PROJECT, MAX_PUSH_PER_RUN - pushedThisRun);
        if (room > 0) {
          // Reads more rows than it can push on purpose. A task that cannot
          // be routed keeps its null zoho_task_id, so a window of exactly
          // `room` rows would let a few unroutable ones sit at the head of the
          // queue and hold up every newer task behind them for good. Postgres
          // rows are cheap; Zoho calls are what the cap protects, and the loop
          // still stops at `room` of those.
          const { data: unsent } = await sb.from("tasks")
            .select("id,title,description,due_at,priority,status")
            .eq("project_id", proj.id)
            .is("zoho_task_id", null)
            .neq("status", "done")   // finished before it ever reached Zoho: history, not work
            .order("created_at", { ascending: true })
            .limit(room * 4 + 1);

          const candidates = unsent || [];

          for (const t of candidates) {
            if (pushed >= room) break;
            // Ownership travels with the task, and it decides two separate
            // things: who Zoho shows as responsible, and which list the task
            // is filed in. Read from task_people and matched by the same rule
            // tasks.jsx uses, so the two never disagree about whose list is
            // whose. Where they do differ is what they are matching against:
            // the browser only knows the lists that already have synced rows
            // on them, while this job asks Zoho, so a list made this morning
            // is one this job can file into and the browser cannot.
            const { data: assignees } = await sb.from("task_people")
              .select("user_id").eq("task_id", t.id).eq("role", "assignee");
            let emails: string[] = [];
            let names: string[] = [];
            if (assignees?.length) {
              const { data: profs } = await sb.from("profiles")
                .select("email,first_name").in("id", assignees.map((a: any) => a.user_id));
              emails = (profs || []).map((p: any) => p.email).filter(Boolean);
              names = (profs || []).map((p: any) => p.first_name || String(p.email || "").split("@")[0]).filter(Boolean);
            }
            // Zoho files a task into exactly one tasklist, and on a project
            // that keeps one list per person the project default is ONE
            // person's list. Accountabilities' default is "Tarek", so this
            // block used to hand Tarek everybody's work (2026-09-23). Ask Zoho
            // what lists the project really has, and route by assignee only
            // where those lists are named after people. A phase-named project,
            // which is every ordinary CTC file, takes the project default
            // exactly as it always has.
            const lists = await loadTasklists();
            if (!lists) { pushSkipped = -3; break; }
            const tasklistId = perPerson
              ? tasklistForNames(names, lists, tasklistCounts)
              // One list and Zoho just named it: use that id rather than the
              // stored default, which was copied in at link time and goes
              // stale the moment somebody deletes or replaces that list. The
              // stored one stays as the fallback for a project whose lists
              // Zoho did not enumerate.
              : (lists.length === 1 ? lists[0].id : proj.zoho_tasklist_id);
            if (!tasklistId) {
              // Only reachable on a per-person project: nobody's list matched,
              // and guessing is the bug itself. The row keeps its null
              // zoho_task_id, so it goes over on a later tick once the list
              // exists or the assignee is fixed, and nothing is lost. Noted on
              // the task, because a skip nobody can see reads exactly like a
              // task that quietly never arrived.
              unrouted++;
              await noteUnrouted(sb, t.id, proj.name, names);
              continue;
            }

            // Deliberately after the routing decision, not before it. This is
            // the one call in the push path that can hit Zoho per task: an
            // email belonging to no Zoho user is never in the cache, so it
            // re-asks every time. Asking only once the task is definitely
            // being created means a skipped task costs nothing at all.
            const ownerIds = await zohoOwnerIds(sb, conn, zFetch, portalBase, emails);

            const form = new URLSearchParams({ name: t.title || "(untitled)" });
            form.set("tasklist_id", tasklistId);
            if (t.description) form.set("description", String(t.description));
            if (t.priority) form.set("priority", tmgPriorityToZoho(t.priority));
            const zd = isoToZohoDate(t.due_at);
            // No start_date companion here: this task does not exist in Zoho
            // yet, so there is no start date to preserve. Zoho filling one in
            // is its own behaviour on create, not a value this job erased.
            if (zd) form.set("end_date", zd);
            if (ownerIds.length) form.set("person_responsible", ownerIds.join(","));

            const cr = await zFetch(`${portalBase}/projects/${proj.zoho_project_id}/tasks/`, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: form.toString(),
            });
            const cd = await cr.json().catch(() => ({}));
            const made = cr.ok ? (cd.tasks || [])[0] : null;
            if (!made) {
              // Left with zoho_task_id still null so the next tick retries it.
              // Nothing is lost and nothing is duplicated.
              continue;
            }
            const mapped = mapZohoTask(made);
            await sb.from("tasks").update({
              zoho_task_id: mapped.id,
              zoho_last_synced_at: new Date().toISOString(),
              zoho_last_modified_time: mapped.last_modified_time,
              zoho_tasklist_id: mapped.tasklist_id,
              zoho_tasklist_name: mapped.tasklist_name,
            }).eq("id", t.id);
            await sb.from("task_activity").insert({
              task_id: t.id, kind: "system",
              content: emails.length && !ownerIds.length
                ? `Sent to Zoho Projects (${proj.name}): unassigned, no Zoho user matches ${emails.join(", ")}.`
                : `Sent to Zoho Projects (${proj.name}).`,
            });
            pushed++; pushedThisRun++;
          }

          // Whatever the window held and this tick did not send: over the cap,
          // or a create Zoho refused. Both come round again next tick.
          const leftover = candidates.length - pushed - unrouted;
          if (pushSkipped === 0 && leftover > 0) pushSkipped = leftover;
        } else if (pushedThisRun >= MAX_PUSH_PER_RUN) {
          pushSkipped = -2;
        }
      }

      // Not stamped when the read was cut short: this stamp IS the incremental
      // cursor, and moving it past tasks the run never saw would skip them for
      // good. An unstamped project simply reads again on the next tick.
      if (!page.truncated) await sb.from("projects").update({ zoho_last_synced_at: new Date().toISOString() }).eq("id", proj.id);
      summary.push({
        project: proj.name, pulled, created, conflicts, pushed,
        ...(page.truncated ? { pull_truncated: "page budget reached, continues next tick" } : {}),
        ...(conflictDeferred > 0 ? { conflicts_deferred: conflictDeferred } : {}),
        ...(unverified > 0 ? { overwrites_unverified: unverified } : {}),
        ...(conflictRowsRejected > 0 ? { conflict_rows_rejected: conflictRowsRejected, conflict_rows_rejected_why: conflictRejectWhy } : {}),
        ...(pushSkipped === -1 ? { push_skipped: "no default tasklist on this project" }
          : pushSkipped === -2 ? { push_skipped: "run cap reached, continues next tick" }
          : pushSkipped === -3 ? { push_skipped: "could not read this project's tasklists from Zoho, retries next tick" }
          : pushSkipped > 0 ? { push_deferred: pushSkipped } : {}),
        ...(unrouted > 0 ? { push_unrouted: unrouted } : {}),
      });
    } catch (e) {
      summary.push({ project: proj.name, error: String((e as any)?.message || e) });
    }
  }

  // pg_net keeps the HTTP response for six hours and only when the call did
  // not time out, and 34 of the 138 responses it had stored already timed out
  // on the trivial 403 workload, so the run's own answer was the one thing
  // about this job nobody could read afterwards. One row, overwritten every
  // tick: `select last_poll_at, last_poll_summary from
  // zoho_projects_connection;`. The function log line is the same answer for
  // anyone already in the Supabase dashboard.
  const finished = { at: new Date().toISOString(), projects: summary };
  console.log(JSON.stringify({ zoho_projects_poll: finished }));
  // Observability is never a reason to fail a run that did its work, and this
  // column arrives with 20260924140000, which may land after the deploy.
  try {
    await sb.from("zoho_projects_connection")
      .update({ last_poll_at: finished.at, last_poll_summary: finished })
      .eq("refresh_token", conn.refresh_token);
  } catch (_) { /* best-effort */ }
  return json({ ok: true, projects: summary }, 200);
});

// Rate-limit math (plan §4): Zoho Projects allows 100 calls/2 min per token.
// This function makes 1 list_tasks call per linked project, plus 1 more for
// each extra page on a project holding more than TASK_PAGE tasks (capped
// run-wide by MAX_TASK_PAGES_PER_RUN), plus at most 1 update_task call per
// task that resolves TMG-wins in a conflict, plus 1 create_task call per task
// pushed to Zoho for the first time. The last two are both capped:
// MAX_CONFLICT_PUSH_PER_RUN on the conflict write-backs, and
// MAX_PUSH_PER_PROJECT / MAX_PUSH_PER_RUN on the creates, so a first run over
// a backlog spreads across ticks instead of tripping the limit. The conflict
// cap matters most on the run right after the change detector was repaired:
// without it that one run would have tried a Zoho write for every task it had
// been skipping since 2026-09-07. Owner lookup usually makes no
// call at all, because the result is cached on zoho_projects_connection and
// shared with zoho-projects; an email that belongs to no Zoho user is never
// in that cache, so in the worst case it is one /users/ call per task
// actually created. It runs AFTER routing for that reason, so a task this
// run skips costs nothing. Tasklist routing adds one /tasklists/ call per
// project that has something to push, once per project per run, and none at
// all for a project with nothing waiting. The pull shares that same one read,
// so a project where Zoho named no owner asks for its tasklists once and the
// push then finds them already in hand: one call per project per run at most,
// never two.
//
// The ceiling is per TOKEN and this job holds one token for the whole run, so
// the number that matters is the RUN's, not one project's. What the caps allow
// run-wide is 60 task pages (MAX_TASK_PAGES_PER_RUN) + one /tasklists/ per
// linked project, 30 of them today + 20 conflict write-backs
// (MAX_CONFLICT_PUSH_PER_RUN) + 40 creates (MAX_PUSH_PER_RUN) + 40 /users/,
// one per create whose assignee is not already cached: 190 calls, which is
// well over the 100-per-2-min ceiling.
//
// No cap is added for it, because 190 needs every maximum at once and the live
// numbers are nowhere near that. 30 linked projects holding 2711 synced rows
// read in roughly 30 to 45 pages; only Accountabilities has anything waiting
// to push at all and MAX_PUSH_PER_PROJECT holds it to 10 creates; the user
// cache normally answers, so /users/ is usually 0; and the conflict branch
// cannot fire on a catch-up run, because it requires a task TMG has stamped
// before and every row is still missing its Zoho timestamp. That is about 45
// to 60 calls on the catch-up run and nearer 30 on an ordinary tick.
//
// What would actually breach it is creates spread across four or more projects
// at the same time as a full re-read of everything. If the linked-project
// count or the create backlog grows that far, lower MAX_PUSH_PER_RUN and
// MAX_TASK_PAGES_PER_RUN together and re-do this arithmetic rather than
// trusting the paragraph above.
// The limit is a burst ceiling PER RUN, not a function of
// cron frequency: running every 5 min instead of 15 doesn't add risk on its
// own, since each run still fires the same one-call-per-linked-project burst.
// Up to ~100 linked projects can poll safely in a single cycle without
// risking Zoho's 30-minute lockout. If linked-project count grows well past
// that, lengthen the interval (or batch across multiple ticks) rather than
// shortening it further.
