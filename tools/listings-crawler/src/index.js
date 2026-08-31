// Orchestrator: run all scrapers, normalize, diff against Supabase, upsert.
import { writeFileSync } from "node:fs";
import { finalize, isAustinMetro } from "./lib/normalize.js";
import { getExisting, upsertListings, deactivateMissing, recordRun } from "./lib/db.js";

import * as ecr from "./scrapers/ecr.js";
import * as aquila from "./scrapers/aquila.js";
import * as hpi from "./scrapers/hpi.js";
import * as cushman from "./scrapers/cushman.js";
import * as kucera from "./scrapers/kucera.js";
import * as donquick from "./scrapers/donquick.js";
import * as jll from "./scrapers/jll.js";

const FETCH_SCRAPERS = [
  ["ecr", ecr],
  ["aquila", aquila],
  ["hpi", hpi],
  ["cushman", cushman],
  ["kucera", kucera],
  ["donquick", donquick],
  ["jll", jll],
];

// Browser-based, experimental; skipped with SKIP_BROWSER=1
const BROWSER_SCRAPERS = [
  ["looplink", () => import("./scrapers/looplink.js")],
  ["liveoak", () => import("./scrapers/liveoak.js")],
];

const today = new Date().toISOString().slice(0, 10);

async function main() {
  const notes = {};
  const collected = [];
  const succeeded = [];

  for (const [key, mod] of FETCH_SCRAPERS) {
    try {
      const rows = await mod.scrape();
      collected.push(...rows.map((r) => finalize(r, key)));
      succeeded.push(key);
      notes[key] = `ok, ${rows.length}`;
      console.log(`✓ ${key}: ${rows.length}`);
    } catch (e) {
      notes[key] = `FAILED: ${e.message}`;
      console.error(`✗ ${key}: ${e.message}`);
    }
  }

  if (!process.env.SKIP_BROWSER) {
    let chromium = null;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      notes.browser = "playwright unavailable, browser scrapers skipped";
    }
    if (chromium) {
      for (const [key, load] of BROWSER_SCRAPERS) {
        try {
          const mod = await load();
          const rows = await mod.scrape({ chromium });
          collected.push(...rows.map((r) => finalize(r, key)));
          succeeded.push(key);
          notes[key] = `ok, ${rows.length}`;
          console.log(`✓ ${key}: ${rows.length}`);
        } catch (e) {
          notes[key] = `FAILED: ${e.message}`;
          console.error(`✗ ${key}: ${e.message}`);
        }
      }
    }
  }

  // Metro guard + dedupe by id
  const byId = new Map();
  for (const l of collected) {
    if (l.city && !isAustinMetro(l.city)) continue;
    if (!byId.has(l.id)) byId.set(l.id, l);
  }
  const listings = [...byId.values()];
  if (!listings.length) {
    console.error("Every scraper failed — aborting without touching the database.");
    writeFileSync("crawl-report.json", JSON.stringify({ today, notes }, null, 2));
    process.exit(1);
  }

  const existing = await getExisting();
  const rows = listings.map((l) => {
    const prev = existing.get(l.id);
    return {
      ...l,
      first_seen: prev ? prev.first_seen : today,
      last_seen: today,
      is_new: !prev,
      active: true,
      updated_at: new Date().toISOString(),
    };
  });

  await upsertListings(rows);
  const deactivated = await deactivateMissing(new Set(rows.map((r) => r.id)), succeeded, today);

  const totals = {
    total: rows.length,
    new: rows.filter((r) => r.is_new).length,
    deactivated,
    per_source: Object.fromEntries(succeeded.map((s) => [s, rows.filter((r) => r.source === s).length])),
  };
  await recordRun(totals, notes);
  writeFileSync("crawl-report.json", JSON.stringify({ today, totals, notes }, null, 2));
  console.log(`Done: ${totals.total} active, ${totals.new} new, ${deactivated} deactivated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
