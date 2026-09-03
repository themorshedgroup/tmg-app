// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: ctc-emails
// Powers the consolidated "Emails" tab on the CTC Files surface: mail that
// Sales Agents and Transaction Coordinators RECEIVE is pulled into one list,
// Claude SUGGESTS which CTC file each belongs to plus a 1–2 sentence overview
// update, and a human approves or rejects. Nothing is ever auto-applied.
//
// Deploy: `supabase functions deploy ctc-emails --no-verify-jwt`
//   "Verify JWT" must be OFF because the `poll` action is cron-invoked with a
//   shared secret and no user session (same shape as zoho-projects-poll).
//   Every OTHER action still verifies a real Supabase session itself, below.
//
// Secrets:
//   CTC_EMAILS_CRON_SECRET = long random string; only this function and its
//                            pg_cron job know it. Deliberately its own secret,
//                            not ZOHO_POLL_CRON_SECRET — rotating one must
//                            never touch the other.
//   GOOGLE_CLIENT_SECRET   = same OAuth client as google-calendar
//   ANTHROPIC_API_KEY      = same key as ai-chat / tasks-ai
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// ── AUTH MODEL (no service account, no domain-wide delegation) ────────────
// This function reads Gmail with the PER-USER Google refresh tokens the app
// already stores in `google_tokens` — the same tokens google-calendar's
// callerAccessToken() mints from, which works with NO user present, which is
// exactly what a cron poller needs. supabase.js already requests
// `gmail.readonly` inside connectCalendar(), so no new scope, no Google Admin
// console change, and no new consent screen entry is required. A person's mail
// is readable only while they personally have the app connected; revoking the
// app's Google access (or disconnecting in Profile) stops the poll for them
// immediately, on their own authority.
//
// ── RLS DECISION (explicit, per table) ────────────────────────────────────
// A Supabase UPDATE that RLS filters out returns 0 rows and NO error — it
// silently does nothing. So NONE of this feature's writes go through the
// browser. Every insert/update below runs on THIS function's service-role
// client, which bypasses RLS entirely, and every write's `error` is checked
// and surfaced. The three tables therefore carry SELECT-only policies for
// authenticated active profiles and NO insert/update/delete policies at all:
//   ctc_mailboxes   — SELECT-only for clients; all writes here (set_mailbox, poll)
//   ctc_emails      — SELECT-only for clients; all writes here (poll, triage, approve, reject)
//   project_updates — SELECT-only for clients; all writes here (approve)
// The UI reads these tables directly with the anon key and calls this function
// for anything that changes them. A missing write policy is then impossible to
// mistake for a working write.
//
// ── PRIVACY POSTURE (mirrors the task_email_links migration) ──────────────
// Only headers + Gmail's own snippet are ever persisted. Full message bodies
// are fetched live into a local variable when the triage model needs more than
// the snippet, used for that one API call, and dropped — never written to any
// table, never logged, never returned to the browser. A mailbox is polled ONLY
// when an admin has explicitly flipped `enabled` on AND the owner still has a
// live google_tokens row AND the owner's profile is still active.
//
// POST actions (full request/response shapes in the deploy notes below):
//   { action: 'poll' }                          → cron (Bearer <CTC_EMAILS_CRON_SECRET>) or an admin session
//   { action: 'triage', limit? }                → active session; Claude suggests file + note
//   { action: 'approve', email_id, project_id?, note? }  → active session; writes project_updates
//   { action: 'reject',  email_id, reason? }    → active session
//   { action: 'list_mailboxes' }                → active session; roster + enabled/connected state
//   { action: 'set_mailbox', user_id, enabled, query_extra? } → ADMIN session only
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Same model the CRM Tasks companion uses (tasks-ai/index.ts) — one place to
// swap models for this feature.
const MODEL = "claude-sonnet-5";

// Public OAuth client id, copied verbatim from google-calendar/index.ts.
const GOOGLE_CLIENT_ID = "931478099859-9jifv0fl9v3s67oc7pa5ka6j61eeujfq.apps.googleusercontent.com";

// ── Poller tuning ────────────────────────────────────────────────────────
const PAGE_SIZE = 50;              // Gmail messages.list page size
const MAX_PAGES_PER_MAILBOX = 6;   // ≤300 messages ingested per mailbox per tick; the rest resumes next tick
const METADATA_CONCURRENCY = 8;    // parallel messages.get calls (5 quota units each)
const DEFAULT_LOOKBACK_DAYS = 14;  // first sweep of a newly enabled mailbox — do NOT ingest years of backlog
const CURSOR_OVERLAP_S = 60;       // re-scan the last minute each sweep; dedup makes the overlap free
// Received mail only. `-from:me` drops the owner's own sends, and chats/drafts/
// spam/trash are never CTC correspondence. Archived mail is still included
// (no `in:inbox`) so a fast-archiving agent's mail is not lost.
const BASE_QUERY = "-in:chats -in:drafts -in:spam -in:trash -from:me";

// ── Triage tuning ────────────────────────────────────────────────────────
const TRIAGE_DEFAULT_LIMIT = 15;
const TRIAGE_MAX_LIMIT = 50;
const MAX_ROSTER = 200;            // above this, shortlist locally before spending tokens
const SHORTLIST_SIZE = 120;
const BODY_CONF_FLOOR = 0.6;       // below this, fetch the body live and ask once more
const MAX_BODY_CHARS = 6000;

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return url && key ? createClient(url, key) : null;
}

// ── Caller auth ──────────────────────────────────────────────────────────
// Verifies the caller's Supabase session and requires an ACTIVE TMG profile.
// Same gate as google-calendar/tasks-ai, plus the access[] roles so set_mailbox
// can require an admin. `access` is a Postgres text[]; 'admin' and 'operations'
// are the admin-ish roles (matches hasAdmin() in tasks.html).
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

// ── Google helpers (mint a stored refresh token → access token) ──────────
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

// Mint an access token for an ARBITRARY user id (not just the caller) — this is
// the "no user present" path a cron poller needs. Throws `needs_connect` when
// there is no stored refresh token or Google has revoked it.
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

function gmailHeader(headers: any[], name: string): string {
  const h = (headers || []).find((x: any) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// Gmail message bodies are base64url (RFC 4648 §5), not plain base64.
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
  return new TextDecoder("utf-8").decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function gmailBodyText(payload: any): string {
  if (!payload) return "";
  const mime = payload.mimeType || "";
  if (mime === "text/plain" && payload.body?.data) return b64urlDecode(payload.body.data);
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) { const t = gmailBodyText(p); if (t) return t; }
  }
  if (mime === "text/html" && payload.body?.data) {
    return b64urlDecode(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return "";
}

// ── Gmail permalink ──────────────────────────────────────────────────────
// NEVER build .../mail/u/0/... — "u/0" is whichever Google account the VIEWER
// happens to have signed in first, and Gmail thread ids are PER MAILBOX, so
// another person's thread id does not resolve in your mailbox at all. We store
// the mailbox owner's address and pin the link to it with ?authuser=. The link
// is therefore expected to work only for that owner (and the UI should label it
// "Open in <owner>'s Gmail"); for anyone else Gmail will show a "no such
// conversation" / account-switch page, which is the honest outcome rather than
// a silently wrong thread.
function gmailPermalink(ownerEmail: string, threadId: string): string {
  return "https://mail.google.com/mail/?authuser=" + encodeURIComponent(ownerEmail) + "#all/" + threadId;
}

// Small bounded-concurrency map — keeps per-message metadata fetches under
// Gmail's per-user rate limit without going fully serial.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function parseFrom(raw: string): { name: string | null; addr: string | null } {
  const s = (raw || "").trim();
  if (!s) return { name: null, addr: null };
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(s);
  if (m) return { name: (m[1] || "").trim() || null, addr: (m[2] || "").trim().toLowerCase() || null };
  return { name: null, addr: s.toLowerCase() };
}

// RFC822 Message-ID, normalised (angle brackets stripped, lowercased). This —
// not Gmail's per-mailbox message id — is the dedup key, so the SAME email
// appearing in both an agent's and a TC's mailbox becomes ONE row.
function normMessageId(raw: string): string | null {
  const s = (raw || "").trim().replace(/^</, "").replace(/>$/, "").trim().toLowerCase();
  return s ? s.slice(0, 500) : null;
}

// ═════════════════════════════════════════════════════════════════════════
// ACTION: poll
// ═════════════════════════════════════════════════════════════════════════
//
// Cursor + pagination design (the failure this exists to prevent: a mailbox
// with more than one page of new mail in the window silently and permanently
// losing the overflow).
//
// Each mailbox row carries:
//   cursor_epoch_s     — safe watermark: everything at or before this is ingested
//   sweep_high_epoch_s — the upper bound of the sweep currently in flight
//   sweep_page_token   — where the in-flight sweep stopped, or null
//
// A sweep queries `after:<cursor> before:<sweep_high+1>` so the result set is
// FROZEN while we page through it — mail arriving mid-sweep cannot shift rows
// across page boundaries. After EVERY successfully ingested page we persist the
// next pageToken, so a crash or a page cap resumes at exactly that page.
// `cursor_epoch_s` only moves to `sweep_high_epoch_s` once the sweep runs out of
// pages, so an interrupted sweep re-covers, never skips. Mail newer than
// sweep_high is above the watermark and is picked up by the next sweep.
// Hitting MAX_PAGES_PER_MAILBOX parks the sweep instead of abandoning it, so a
// large backlog drains over several ticks rather than looping forever.
async function pollMailbox(sb: any, mb: any, opts: { lookbackDays: number }) {
  const stat: Record<string, unknown> = {
    mailbox: mb.email, user_id: mb.user_id,
    pages: 0, seen: 0, inserted: 0, also_seen: 0, resumed: !!mb.sweep_page_token,
  };

  // Gate 1: the owner's profile must still be active (someone who left the
  // company must stop being polled even if nobody flipped `enabled` off).
  const { data: prof, error: profErr } = await sb
    .from("profiles").select("status, email").eq("id", mb.user_id).maybeSingle();
  if (profErr) throw new Error("profile read failed: " + profErr.message);
  if (!prof || prof.status !== "active") {
    await sb.from("ctc_mailboxes")
      .update({ last_polled_at: new Date().toISOString(), last_error: "owner_not_active" })
      .eq("user_id", mb.user_id);
    return { ...stat, skipped_reason: "owner_not_active" };
  }

  // Gate 2: the owner must personally have a live google_tokens row. No token →
  // no poll, and we say so rather than pretending the mailbox is quiet.
  const accessToken = await userAccessToken(sb, mb.user_id); // throws needs_connect

  // The mailbox address must be the GOOGLE account this token belongs to, not
  // the TMG profile address — they are not always the same person's spelling,
  // and every Gmail permalink is pinned to it via ?authuser=. Ask Gmail who it
  // thinks we are and correct the row if it drifted, so links open the right
  // account and also_seen_in bookkeeping compares like with like.
  try {
    const pr = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: "Bearer " + accessToken },
    });
    const pd = await pr.json().catch(() => ({}));
    const real = (pd?.emailAddress || "").toLowerCase();
    if (real && real !== String(mb.email || "").toLowerCase()) {
      await sb.from("ctc_mailboxes").update({ email: real, updated_at: new Date().toISOString() }).eq("user_id", mb.user_id);
      mb = { ...mb, email: real };
      stat.mailbox = real;
    }
  } catch (_) { /* non-fatal: keep the stored address for this run */ }

  const nowS = Math.floor(Date.now() / 1000);
  let sweepHigh: number = Number(mb.sweep_high_epoch_s) || 0;
  let pageToken: string | null = mb.sweep_page_token || null;
  const cursor: number = Number(mb.cursor_epoch_s) || (nowS - opts.lookbackDays * 86400);

  if (!pageToken || !sweepHigh) {
    // Fresh sweep.
    sweepHigh = nowS;
    pageToken = null;
    const { error } = await sb.from("ctc_mailboxes")
      .update({ sweep_high_epoch_s: sweepHigh, sweep_page_token: null })
      .eq("user_id", mb.user_id);
    if (error) throw new Error("cursor init failed: " + error.message);
  }

  const q = [
    BASE_QUERY,
    (mb.query_extra || "").trim(),
    "after:" + Math.max(0, cursor - CURSOR_OVERLAP_S),
    "before:" + (sweepHigh + 1),
  ].filter(Boolean).join(" ");

  let pages = 0, seen = 0, inserted = 0, alsoSeen = 0;

  while (pages < MAX_PAGES_PER_MAILBOX) {
    let pageIncomplete = false;   // set when a message in this page couldn't be fetched
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("maxResults", String(PAGE_SIZE));
    listUrl.searchParams.set("q", q);
    if (pageToken) listUrl.searchParams.set("pageToken", pageToken);

    const lr = await fetch(listUrl.toString(), { headers: { Authorization: "Bearer " + accessToken } });
    const ld = await lr.json().catch(() => ({}));
    if (!lr.ok) {
      // A stale/rejected pageToken is recoverable: drop it and let the next tick
      // restart this sweep from the top. Re-ingest is free (dedup on Message-ID).
      if (lr.status === 400 && pageToken) {
        await sb.from("ctc_mailboxes")
          .update({ sweep_page_token: null, sweep_high_epoch_s: null, last_error: "page_token_expired" })
          .eq("user_id", mb.user_id);
        throw new Error("page_token_expired (sweep will restart next tick)");
      }
      throw new Error(ld?.error?.message || ("Gmail list failed (HTTP " + lr.status + ")"));
    }

    const ids: string[] = (ld.messages || []).map((m: any) => m.id).filter(Boolean);
    const nextToken: string | null = ld.nextPageToken || null;

    if (ids.length) {
      // Metadata ONLY — never format=full here. Message-ID is requested
      // explicitly because it is the cross-mailbox dedup key.
      const metas = await mapLimit(ids, METADATA_CONCURRENCY, async (id) => {
        const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(id));
        u.searchParams.set("format", "metadata");
        ["From", "To", "Subject", "Date", "Message-ID"].forEach((h) => u.searchParams.append("metadataHeaders", h));
        const r = await fetch(u.toString(), { headers: { Authorization: "Bearer " + accessToken } });
        if (!r.ok) return null;
        return await r.json().catch(() => null);
      });

      // A null here is a message Gmail would not hand over this run (429, 5xx,
      // a transient network drop). Ingesting the rest of the page and then
      // checkpointing past it would lose that mail PERMANENTLY and silently:
      // the next run resumes from the following page and never looks back.
      // So: ingest what we got (upserts are idempotent on rfc_message_id), then
      // stop the sweep HERE without advancing the page token, so this exact
      // page is re-fetched next run.
      const missed = metas.filter((m) => !m).length;
      if (missed) pageIncomplete = true;

      const rows: any[] = [];
      const byMsgId = new Map<string, any>();
      for (const m of metas) {
        if (!m) continue;
        seen++;
        const headers = m.payload?.headers || [];
        const from = parseFrom(gmailHeader(headers, "From"));
        // Belt-and-braces on `-from:me`: never ingest the owner's own sends.
        if (from.addr && prof.email && from.addr === String(prof.email).toLowerCase()) continue;

        // A malformed message with no Message-ID still gets a stable, unique key
        // (scoped to this mailbox) rather than being dropped — it just cannot be
        // deduped against another mailbox's copy.
        const rfc = normMessageId(gmailHeader(headers, "Message-ID"))
          || ("gmail-nomsgid:" + mb.user_id + ":" + m.id);

        const internalMs = Number(m.internalDate) || null;
        const row = {
          rfc_message_id: rfc,
          gmail_message_id: m.id,
          gmail_thread_id: m.threadId || null,
          mailbox_user_id: mb.user_id,
          mailbox_email: mb.email,
          permalink: m.threadId ? gmailPermalink(mb.email, m.threadId) : null,
          from_addr: from.addr,
          from_name: from.name,
          to_addr: gmailHeader(headers, "To").slice(0, 500) || null,
          subject: (gmailHeader(headers, "Subject") || "(no subject)").slice(0, 500),
          snippet: (m.snippet || "").slice(0, 1000), // Gmail's own snippet — NOT the body
          email_date: internalMs ? new Date(internalMs).toISOString() : null,
          internal_date_ms: internalMs,
          status: "new",
        };
        if (!byMsgId.has(rfc)) { byMsgId.set(rfc, row); rows.push(row); }
      }

      if (rows.length) {
        // One round-trip to find which of these already exist (typically because
        // the other side of the thread — agent or TC — was polled first).
        const keys = rows.map((r) => r.rfc_message_id);
        const { data: existing, error: exErr } = await sb
          .from("ctc_emails").select("rfc_message_id, mailbox_email, also_seen_in").in("rfc_message_id", keys);
        if (exErr) throw new Error("dedup read failed: " + exErr.message);

        const known = new Map<string, any>();
        (existing || []).forEach((e: any) => known.set(e.rfc_message_id, e));

        const fresh = rows.filter((r) => !known.has(r.rfc_message_id));
        if (fresh.length) {
          // ignoreDuplicates so a race with another mailbox in a concurrent run
          // cannot 409 the whole page. The unique index on rfc_message_id is what
          // actually enforces "one row per real email".
          // ON CONFLICT DO NOTHING + select → the returned rows are the ones that
          // ACTUALLY landed, so the reported count is real rather than optimistic.
          const { data: put, error: insErr } = await sb
            .from("ctc_emails").upsert(fresh, { onConflict: "rfc_message_id", ignoreDuplicates: true }).select("id");
          if (insErr) throw new Error("insert failed: " + insErr.message);
          inserted += (put || []).length;
        }

        // Same email, second mailbox: record the extra mailbox rather than
        // creating a duplicate row, so the UI can show "also in Jane's inbox".
        for (const r of rows) {
          const e = known.get(r.rfc_message_id);
          if (!e) continue;
          if (e.mailbox_email === r.mailbox_email) continue;
          const list: string[] = Array.isArray(e.also_seen_in) ? e.also_seen_in : [];
          if (list.includes(r.mailbox_email)) continue;
          const { error: upErr } = await sb.from("ctc_emails")
            .update({ also_seen_in: [...list, r.mailbox_email] })
            .eq("rfc_message_id", r.rfc_message_id);
          if (upErr) throw new Error("also_seen_in update failed: " + upErr.message);
          alsoSeen++;
        }
      }
    }

    pages++;

    if (pageIncomplete) {
      // Leave sweep_page_token pointing at THIS page so the next run re-fetches
      // it. Recorded as an error so a mailbox that keeps failing is visible in
      // the admin panel instead of quietly standing still.
      const { error: ckErr } = await sb.from("ctc_mailboxes")
        .update({ sweep_page_token: pageToken, last_polled_at: new Date().toISOString(), last_error: "partial page — some messages could not be fetched; will retry this page" })
        .eq("user_id", mb.user_id);
      if (ckErr) throw new Error("checkpoint failed: " + ckErr.message);
      return { ...stat, pages, seen, inserted, also_seen: alsoSeen, sweep_complete: false, more_pending: true, retrying_page: true };
    }

    pageToken = nextToken;

    // Persist the resume point AFTER the page is fully ingested — this is the
    // only moment it is safe to move.
    const { error: ckErr } = await sb.from("ctc_mailboxes")
      .update({ sweep_page_token: pageToken, last_polled_at: new Date().toISOString(), last_error: null })
      .eq("user_id", mb.user_id);
    if (ckErr) throw new Error("checkpoint failed: " + ckErr.message);

    if (!pageToken) break; // sweep exhausted
  }

  const done = !pageToken;
  if (done) {
    // Only now is it safe to move the watermark past this window.
    const { error } = await sb.from("ctc_mailboxes").update({
      cursor_epoch_s: sweepHigh,
      sweep_high_epoch_s: null,
      sweep_page_token: null,
      last_polled_at: new Date().toISOString(),
      last_error: null,
    }).eq("user_id", mb.user_id);
    if (error) throw new Error("cursor advance failed: " + error.message);
  }

  return { ...stat, pages, seen, inserted, also_seen: alsoSeen, sweep_complete: done, more_pending: !done };
}

// ═════════════════════════════════════════════════════════════════════════
// ACTION: triage — Claude suggests a CTC file + a short overview update
// ═════════════════════════════════════════════════════════════════════════

const TRIAGE_SYSTEM = [
  "You match one inbound email to one CTC (contract-to-close) transaction file for a commercial real estate brokerage.",
  "A CTC file's NAME IS THE PROPERTY ADDRESS. Match on the address: street number plus street name is the strongest signal.",
  "Also weigh the subject line, the sender's domain, escrow/title/loan numbers, and any party names that appear in the file name.",
  "A street NUMBER that does not match is disqualifying, even when the street name matches.",
  "You may answer with no match. Answering 'no match' is CORRECT and expected when nothing in the email identifies a specific property — newsletters, generic vendor mail, internal chatter, marketing. Do not force a match.",
  "If the note would be a guess, set project_id to null instead.",
  "",
  "The note is a factual 1-2 sentence update for that file's Overview, written for a transaction coordinator:",
  "what happened or what is now required, and by when if a date is stated. No greeting, no sign-off, no 'this email says'.",
  "",
  "Reply with ONE JSON object and nothing else:",
  '{"project_id": "<uuid from the list, or null>", "confidence": <0.0-1.0>, "note": "<1-2 sentences, or empty string when project_id is null>", "reason": "<max 15 words>", "need_body": <true|false>}',
  "Set need_body to true only when the subject and snippet genuinely cannot identify the property but the full message plausibly could.",
].join("\n");

// When the roster is large, spend tokens only on plausible candidates: rank CTC
// file names by shared tokens with the email's subject/snippet/sender, keeping
// street numbers weighted heavily. Purely a cost control — the model still
// decides, and still may answer "no match".
function shortlistProjects(projects: any[], hay: string): any[] {
  if (projects.length <= MAX_ROSTER) return projects;
  const words = new Set((hay.toLowerCase().match(/[a-z0-9']{2,}/g) || []));
  const scored = projects.map((p) => {
    const toks = (String(p.name || "").toLowerCase().match(/[a-z0-9']{2,}/g) || []);
    let score = 0;
    for (const t of toks) {
      if (!words.has(t)) continue;
      score += /^\d+$/.test(t) ? 4 : 1; // a matching street number is worth far more than "street"
    }
    return { p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, SHORTLIST_SIZE).map((s) => s.p);
}

async function askClaude(apiKey: string, messages: any[], maxTokens = 700) {
  // Request shape copied from tasks-ai/index.ts — same endpoint, same headers,
  // same anthropic-version, same model constant.
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: TRIAGE_SYSTEM, messages }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || "Claude API error");
  return data;
}

function textOf(data: any): string {
  return (data?.content || []).filter((b: any) => b?.type === "text").map((b: any) => b.text || "").join("\n").trim();
}

// The model is told to emit bare JSON, but a stray code fence or preamble must
// not break triage — pull the first balanced object out of the text.
function parseSuggestion(text: string): any | null {
  let t = (text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

function emailPrompt(email: any, projects: any[], body: string | null): string {
  const roster = projects.map((p) => "- " + p.id + "  |  " + p.name).join("\n") || "(no open CTC files)";
  const parts = [
    "CTC FILES (id | property address):",
    roster,
    "",
    "EMAIL:",
    "From: " + (email.from_name ? email.from_name + " <" + (email.from_addr || "") + ">" : (email.from_addr || "unknown")),
    "To: " + (email.to_addr || ""),
    "Date: " + (email.email_date || ""),
    "Subject: " + (email.subject || ""),
    "Snippet: " + (email.snippet || ""),
  ];
  if (body) parts.push("", "FULL BODY (fetched live, not stored):", body.slice(0, MAX_BODY_CHARS));
  return parts.join("\n");
}

// ═════════════════════════════════════════════════════════════════════════
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action;
    if (!action) return json({ error: "Missing action." }, 400);

    // ── poll: cron shared secret, OR an admin session (the "Sync now" button) ──
    if (action === "poll") {
      const secret = Deno.env.get("CTC_EMAILS_CRON_SECRET") || "";
      const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      let sb: any = null;
      let via = "cron";

      if (secret && bearer && bearer === secret) {
        sb = serviceClient();
      } else {
        // Not the cron secret — fall back to a real session and require admin.
        const auth = await authorizeCaller(req);
        if (!auth.ok) return json({ error: "unauthorized" }, 401);
        if (!auth.isAdmin) return json({ error: "Admin access required to run a poll." }, 403);
        sb = auth.sb; via = "admin:" + auth.userId;
      }
      if (!sb) return json({ error: "server not configured" }, 500);

      const lookbackDays = Math.min(Math.max(Number(body.lookback_days) || DEFAULT_LOOKBACK_DAYS, 1), 90);

      // ONLY mailboxes an admin explicitly enabled. The active-profile and
      // live-google_tokens gates are enforced inside pollMailbox.
      const { data: mailboxes, error: mbErr } = await sb
        .from("ctc_mailboxes")
        .select("user_id,email,enabled,query_extra,cursor_epoch_s,sweep_high_epoch_s,sweep_page_token")
        .eq("enabled", true);
      if (mbErr) return json({ error: "mailbox read failed: " + mbErr.message }, 500);

      const results: any[] = [];
      for (const mb of mailboxes || []) {
        // One mailbox failing must never abort the others.
        try {
          results.push(await pollMailbox(sb, mb, { lookbackDays }));
        } catch (e) {
          const msg = String((e as any)?.message || e);
          try {
            await sb.from("ctc_mailboxes")
              .update({ last_polled_at: new Date().toISOString(), last_error: msg.slice(0, 500) })
              .eq("user_id", mb.user_id);
          } catch (_) { /* reporting the error must not itself abort the run */ }
          results.push({ mailbox: mb.email, user_id: mb.user_id, error: msg });
        }
      }

      return json({
        ok: true, via,
        mailboxes: results,
        totals: {
          mailboxes: results.length,
          inserted: results.reduce((n, r) => n + (Number(r.inserted) || 0), 0),
          also_seen: results.reduce((n, r) => n + (Number(r.also_seen) || 0), 0),
          errors: results.filter((r) => r.error).length,
          more_pending: results.filter((r) => r.more_pending).length,
        },
      }, 200);
    }

    // ── Every remaining action needs a real, active TMG session ──
    const auth = await authorizeCaller(req);
    if (!auth.ok) return json({ error: auth.error }, auth.status);
    const sb = auth.sb;

    // ── list_mailboxes: the roster the admin screen renders ──────────────
    // SUGGESTED roster = active profiles whose access[] contains 'agent' or 'tc'
    // (`access` is a Postgres text[] → overlaps/&&, never IN). But the AUTHORITY
    // is the per-mailbox `enabled` flag: a row that exists with enabled=true is
    // polled even if the person's roles later change, and a suggested person is
    // NOT polled until an admin turns them on. `connected` reports whether that
    // person actually has a live google_tokens row — enabled without connected
    // means the poller can do nothing until they connect Google themselves.
    if (action === "list_mailboxes") {
      const { data: rows, error: mErr } = await sb
        .from("ctc_mailboxes")
        .select("user_id,email,enabled,query_extra,cursor_epoch_s,sweep_page_token,last_polled_at,last_error");
      if (mErr) return json({ error: mErr.message }, 500);

      const { data: suggested, error: sErr } = await sb
        .from("profiles").select("id,email,first_name,last_name,access,status")
        .eq("status", "active").overlaps("access", ["agent", "tc"]);
      if (sErr) return json({ error: sErr.message }, 500);

      const byUser = new Map<string, any>();
      (rows || []).forEach((r: any) => byUser.set(r.user_id, r));

      const ids = new Set<string>([...(rows || []).map((r: any) => r.user_id), ...(suggested || []).map((p: any) => p.id)]);
      const { data: tokens } = await sb
        .from("google_tokens").select("user_id").in("user_id", [...ids].length ? [...ids] : ["00000000-0000-0000-0000-000000000000"]);
      const connected = new Set<string>((tokens || []).map((t: any) => t.user_id));

      // Names for any enabled mailbox whose owner is no longer in the suggested set.
      const { data: allProfiles } = await sb
        .from("profiles").select("id,email,first_name,last_name,access,status").in("id", [...ids].length ? [...ids] : ["00000000-0000-0000-0000-000000000000"]);
      const profById = new Map<string, any>();
      (allProfiles || []).forEach((p: any) => profById.set(p.id, p));

      const mailboxes = [...ids].map((id) => {
        const r = byUser.get(id) || null;
        const p = profById.get(id) || null;
        const roles: string[] = p && Array.isArray(p.access) ? p.access : [];
        return {
          user_id: id,
          email: (r?.email || p?.email || null),
          name: p ? [p.first_name, p.last_name].filter(Boolean).join(" ") || p.email : null,
          roles,
          suggested: roles.some((x) => x === "agent" || x === "tc") && p?.status === "active",
          profile_status: p?.status || null,
          enabled: !!r?.enabled,          // ← the authority
          configured: !!r,
          connected: connected.has(id),   // live google_tokens row
          query_extra: r?.query_extra || null,
          cursor_epoch_s: r?.cursor_epoch_s ?? null,
          sweep_in_progress: !!r?.sweep_page_token,
          last_polled_at: r?.last_polled_at || null,
          last_error: r?.last_error || null,
        };
      }).sort((a, b) => String(a.name || a.email || "").localeCompare(String(b.name || b.email || "")));

      return json({ mailboxes, can_edit: auth.isAdmin }, 200);
    }

    // ── set_mailbox: ADMIN only — enabling a mailbox means reading someone's mail ──
    if (action === "set_mailbox") {
      if (!auth.isAdmin) return json({ error: "Admin access required." }, 403);
      const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
      if (!userId) return json({ error: "Missing user_id." }, 400);
      if (typeof body.enabled !== "boolean") return json({ error: "enabled must be true or false." }, 400);

      // The mailbox address is resolved SERVER-SIDE from the profile — never taken
      // from the client, because it is what the Gmail permalink is pinned to.
      const { data: prof, error: pErr } = await sb
        .from("profiles").select("id,email,status").eq("id", userId).maybeSingle();
      if (pErr) return json({ error: pErr.message }, 500);
      if (!prof) return json({ error: "No such profile." }, 404);
      if (prof.status !== "active") return json({ error: "That profile is not active." }, 400);
      if (!prof.email) return json({ error: "That profile has no email address on file." }, 400);

      const patch: Record<string, unknown> = {
        user_id: userId,
        email: String(prof.email).toLowerCase(),
        enabled: body.enabled,
        updated_at: new Date().toISOString(),
      };
      if (typeof body.query_extra === "string") patch.query_extra = body.query_extra.trim().slice(0, 200) || null;

      const { data: saved, error } = await sb
        .from("ctc_mailboxes").upsert(patch, { onConflict: "user_id" }).select().single();
      if (error) return json({ error: error.message }, 500);

      const { data: tok } = await sb
        .from("google_tokens").select("user_id").eq("user_id", userId).maybeSingle();

      return json({
        ok: true,
        mailbox: {
          user_id: saved.user_id, email: saved.email, enabled: saved.enabled,
          query_extra: saved.query_extra || null, connected: !!tok,
        },
        // An enabled-but-not-connected mailbox produces nothing until its owner
        // connects Google themselves — say so plainly instead of failing silently.
        warning: (body.enabled && !tok)
          ? "Enabled, but this person has not connected Google in the app yet — nothing will be polled until they do."
          : null,
      }, 200);
    }

    // ── triage: suggest a CTC file + a draft note. NEVER applies anything. ──
    if (action === "triage") {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not set in Supabase secrets." }, 500);

      const limit = Math.min(Math.max(Number(body.limit) || TRIAGE_DEFAULT_LIMIT, 1), TRIAGE_MAX_LIMIT);

      let q = sb.from("ctc_emails")
        .select("id,rfc_message_id,gmail_message_id,mailbox_user_id,mailbox_email,from_addr,from_name,to_addr,subject,snippet,email_date")
        .eq("status", "new")
        .order("email_date", { ascending: false })
        .limit(limit);
      if (Array.isArray(body.email_ids) && body.email_ids.length) {
        // Re-triage specific rows (e.g. a "try again" button) regardless of status.
        q = sb.from("ctc_emails")
          .select("id,rfc_message_id,gmail_message_id,mailbox_user_id,mailbox_email,from_addr,from_name,to_addr,subject,snippet,email_date")
          .in("id", body.email_ids.slice(0, TRIAGE_MAX_LIMIT));
      }
      const { data: emails, error: eErr } = await q;
      if (eErr) return json({ error: eErr.message }, 500);
      if (!emails || !emails.length) return json({ ok: true, triaged: 0, results: [] }, 200);

      const { data: projects, error: pErr } = await sb
        .from("projects").select("id,name")
        .eq("record_type", "ctc_file").eq("archived", false)
        .order("name", { ascending: true });
      if (pErr) return json({ error: pErr.message }, 500);
      const roster = projects || [];
      const validIds = new Set<string>(roster.map((p: any) => p.id));

      // Access tokens are minted once per mailbox owner, and only if a body is
      // actually needed. Cached for this request only.
      const tokenCache = new Map<string, string | null>();
      const tokenFor = async (uid: string): Promise<string | null> => {
        if (tokenCache.has(uid)) return tokenCache.get(uid)!;
        let t: string | null = null;
        try { t = await userAccessToken(sb, uid); } catch (_) { t = null; }
        tokenCache.set(uid, t);
        return t;
      };

      const results: any[] = [];
      let inTok = 0, outTok = 0;

      for (const em of emails) {
        try {
          const hay = [em.subject, em.snippet, em.from_addr, em.from_name].filter(Boolean).join(" ");
          const candidates = shortlistProjects(roster, hay);

          // Pass 1 — headers + snippet only. No body has been fetched yet.
          let data = await askClaude(apiKey, [{ role: "user", content: emailPrompt(em, candidates, null) }]);
          inTok += data?.usage?.input_tokens || 0; outTok += data?.usage?.output_tokens || 0;
          let sug = parseSuggestion(textOf(data));

          const wantsBody = !!sug?.need_body || (Number(sug?.confidence) || 0) < BODY_CONF_FLOOR;
          if (wantsBody && em.gmail_message_id && em.mailbox_user_id) {
            const at = await tokenFor(em.mailbox_user_id);
            if (at) {
              // LIVE fetch, held in a local variable for exactly one API call and
              // then dropped. Never written to any table, never returned to the
              // browser, never logged.
              const u = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages/" + encodeURIComponent(em.gmail_message_id));
              u.searchParams.set("format", "full");
              const r = await fetch(u.toString(), { headers: { Authorization: "Bearer " + at } });
              if (r.ok) {
                const d = await r.json().catch(() => null);
                const bodyText = d ? gmailBodyText(d.payload) : "";
                if (bodyText) {
                  data = await askClaude(apiKey, [{ role: "user", content: emailPrompt(em, candidates, bodyText) }]);
                  inTok += data?.usage?.input_tokens || 0; outTok += data?.usage?.output_tokens || 0;
                  sug = parseSuggestion(textOf(data)) || sug;
                }
              }
            }
          }

          if (!sug) {
            results.push({ email_id: em.id, error: "Could not parse the model's reply." });
            continue;
          }

          // A hallucinated or stale project id must never become a suggestion.
          const pid = (typeof sug.project_id === "string" && validIds.has(sug.project_id)) ? sug.project_id : null;
          const conf = Math.max(0, Math.min(1, Number(sug.confidence) || 0));
          const note = pid ? String(sug.note || "").trim().slice(0, 600) : "";
          const reason = String(sug.reason || "").trim().slice(0, 200) || null;

          const { error: uErr } = await sb.from("ctc_emails").update({
            status: pid ? "suggested" : "no_match",   // NOT 'approved' — a human still decides
            suggested_project_id: pid,
            suggested_note: note || null,
            suggested_confidence: pid ? conf : null,
            suggested_reason: reason,
            triaged_at: new Date().toISOString(),
          }).eq("id", em.id);
          if (uErr) { results.push({ email_id: em.id, error: uErr.message }); continue; }

          results.push({
            email_id: em.id,
            suggested_project_id: pid,
            suggested_project_name: pid ? (roster.find((p: any) => p.id === pid)?.name || null) : null,
            confidence: pid ? conf : null,
            note: note || null,
            reason,
            status: pid ? "suggested" : "no_match",
          });
        } catch (e) {
          // One bad email must not kill the batch.
          results.push({ email_id: em.id, error: String((e as any)?.message || e) });
        }
      }

      // Best-effort usage logging, same table/shape as tasks-ai. Never blocks.
      try {
        await sb.from("usage_log").insert({
          user_id: auth.userId, feature: "ctc_emails_triage", model: MODEL,
          input_tokens: inTok, output_tokens: outTok,
        });
      } catch (_) { /* swallow */ }

      return json({ ok: true, triaged: results.filter((r) => !r.error).length, results }, 200);
    }

    // ── approve: a human accepts. THIS is the only write to project_updates. ──
    // projects.outcome is deliberately NOT touched — it is rendered in three
    // separate views (tasks.html ~3588, ~3610, ~3901) and appending update notes
    // to it would wreck all three. Updates live in their own table.
    if (action === "approve") {
      const emailId = typeof body.email_id === "string" ? body.email_id.trim() : "";
      if (!emailId) return json({ error: "Missing email_id." }, 400);

      const { data: em, error: eErr } = await sb
        .from("ctc_emails")
        .select("id,status,subject,from_addr,email_date,permalink,mailbox_email,linked_project_id,suggested_project_id,suggested_note")
        .eq("id", emailId).maybeSingle();
      if (eErr) return json({ error: eErr.message }, 500);
      if (!em) return json({ error: "No such email." }, 404);
      if (em.status === "approved") {
        // Idempotent: a double-click must not add a second Overview update.
        return json({ ok: true, already: true, project_id: em.linked_project_id }, 200);
      }

      const projectId = (typeof body.project_id === "string" && body.project_id.trim())
        ? body.project_id.trim() : em.suggested_project_id;
      if (!projectId) return json({ error: "No CTC file chosen and no suggestion to fall back on." }, 400);

      const { data: proj, error: pErr } = await sb
        .from("projects").select("id,name,record_type,archived").eq("id", projectId).maybeSingle();
      if (pErr) return json({ error: pErr.message }, 500);
      if (!proj) return json({ error: "No such CTC file." }, 404);
      if (proj.record_type !== "ctc_file") return json({ error: "That record is not a CTC file." }, 400);
      if (proj.archived) return json({ error: "That CTC file is archived." }, 400);

      const note = (typeof body.note === "string" && body.note.trim())
        ? body.note.trim().slice(0, 2000)
        : String(em.suggested_note || "").trim().slice(0, 2000);
      if (!note) return json({ error: "Nothing to add — the update note is empty." }, 400);

      const { data: upd, error: uiErr } = await sb.from("project_updates").insert({
        project_id: projectId,
        body: note,
        source: "email",
        source_email_id: em.id,
        created_by: auth.userId,
      }).select("id,created_at").single();
      if (uiErr) return json({ error: "Could not add the update: " + uiErr.message }, 500);

      const { data: linked, error: lErr } = await sb.from("ctc_emails").update({
        status: "approved",
        linked_project_id: projectId,
        approved_note: note,
        decided_by: auth.userId,
        decided_at: new Date().toISOString(),
      }).eq("id", em.id).select("id,status,linked_project_id").single();
      if (lErr) {
        // The Overview update landed but the link did not — say so instead of
        // reporting a clean success the UI would render as fully done.
        return json({ error: "Update added, but linking the email failed: " + lErr.message, update_id: upd.id }, 500);
      }

      return json({
        ok: true,
        email: linked,
        project: { id: proj.id, name: proj.name },
        update: { id: upd.id, body: note, created_at: upd.created_at },
      }, 200);
    }

    // ── reject: stop suggesting this one ─────────────────────────────────
    if (action === "reject") {
      const emailId = typeof body.email_id === "string" ? body.email_id.trim() : "";
      if (!emailId) return json({ error: "Missing email_id." }, 400);

      const { data: row, error } = await sb.from("ctc_emails").update({
        status: "rejected",
        rejected_reason: (typeof body.reason === "string" ? body.reason.trim().slice(0, 300) : null) || null,
        decided_by: auth.userId,
        decided_at: new Date().toISOString(),
      }).eq("id", emailId).select("id,status").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      // Service-role bypasses RLS, so a null row here really does mean "no such
      // id" — not a policy quietly filtering the write out.
      if (!row) return json({ error: "No such email." }, 404);
      return json({ ok: true, email: row }, 200);
    }

    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
