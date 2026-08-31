// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: crawl-listings
// Replaces the GitHub Actions schedule for the Austin broker crawl. Same
// shape as zoho-projects-poll: cron-invoked, a shared-secret header
// authenticates the caller instead of a user session.
//
// Deploy: `supabase functions deploy crawl-listings --no-verify-jwt`.
//   Leave "Verify JWT" OFF — auth is the secret check below (there is no user).
//
// Secrets:
//   CRAWL_CRON_SECRET = long random string, known only to this function and
//                       its pg_cron jobs.
//   (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
//
// ONE BROKER PER INVOCATION. A single source can page up to 25 times, so
// running all five in one request risks the wall-clock limit. pg_cron fires
// five staggered jobs instead, each passing its own `source`.
//
// The scrapers under ./scrapers and ./lib are the same files the CLI crawler
// uses (tools/listings-crawler), copied rather than rewritten so the parsing
// logic stays identical; only the cheerio import specifier differs.
//
// A failed source never wipes data: deactivation only runs for the source
// that just crawled successfully, and only for ids it did not see.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { finalize, isAustinMetro } from "./lib/normalize.js";

import * as ecr from "./scrapers/ecr.js";
import * as aquila from "./scrapers/aquila.js";
import * as hpi from "./scrapers/hpi.js";
import * as cushman from "./scrapers/cushman.js";
import * as kucera from "./scrapers/kucera.js";

const SCRAPERS: Record<string, { scrape: () => Promise<any[]> }> = {
  ecr, aquila, hpi, cushman, kucera,
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing.");
  return createClient(url, key, { auth: { persistSession: false } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const expected = Deno.env.get("CRAWL_CRON_SECRET") || "";
  const got = req.headers.get("x-cron-secret") || "";
  if (!expected || got !== expected) return json({ error: "unauthorized" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* allow empty body */ }
  const source = String(body.source || new URL(req.url).searchParams.get("source") || "").trim();

  if (!SCRAPERS[source]) {
    return json({ error: `unknown source '${source}'`, valid: Object.keys(SCRAPERS) }, 400);
  }

  const sb = serviceClient();
  const today = new Date().toISOString().slice(0, 10);
  const startedAt = Date.now();

  let rows: any[];
  try {
    const raw = await SCRAPERS[source].scrape();
    const byId = new Map<string, any>();
    for (const r of raw) {
      const l = finalize(r, source);
      if (l.city && !isAustinMetro(l.city)) continue;
      if (!byId.has(l.id)) byId.set(l.id, l);
    }
    rows = [...byId.values()];
  } catch (e) {
    // Log the failure but leave this source's existing rows untouched.
    await sb.from("crawl_runs").insert({
      totals: { source, total: 0, failed: true },
      notes: { [source]: `FAILED: ${e instanceof Error ? e.message : String(e)}` },
    });
    return json({ ok: false, source, error: e instanceof Error ? e.message : String(e) }, 502);
  }

  if (!rows.length) {
    await sb.from("crawl_runs").insert({
      totals: { source, total: 0, failed: true },
      notes: { [source]: "FAILED: zero listings parsed — refusing to deactivate" },
    });
    return json({ ok: false, source, error: "zero listings parsed" }, 502);
  }

  // Which of this source's ids already exist, so first_seen survives.
  const existing = new Map<string, any>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from("listings").select("id, first_seen").eq("source", source).range(from, from + 999);
    if (error) return json({ ok: false, source, error: error.message }, 500);
    for (const r of data) existing.set(r.id, r);
    if (data.length < 1000) break;
  }

  const payload = rows.map((l) => ({
    ...l,
    first_seen: existing.get(l.id)?.first_seen ?? today,
    last_seen: today,
    is_new: !existing.has(l.id),
    active: true,
    updated_at: new Date().toISOString(),
  }));

  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await sb.from("listings").upsert(payload.slice(i, i + 200));
    if (error) return json({ ok: false, source, error: error.message }, 500);
  }

  // Deactivate only this source's rows that this successful run did not see.
  const seen = new Set(payload.map((r) => r.id));
  const gone = [...existing.keys()].filter((id) => !seen.has(id));
  for (let i = 0; i < gone.length; i += 200) {
    await sb.from("listings")
      .update({ active: false, is_new: false, updated_at: new Date().toISOString() })
      .in("id", gone.slice(i, i + 200));
  }

  const totals = {
    source,
    total: payload.length,
    new: payload.filter((r) => r.is_new).length,
    deactivated: gone.length,
    ms: Date.now() - startedAt,
  };
  await sb.from("crawl_runs").insert({ totals, notes: { [source]: `ok, ${payload.length}` } });
  return json({ ok: true, ...totals });
});
