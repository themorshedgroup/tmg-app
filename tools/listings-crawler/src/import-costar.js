// Ingest a CoStar Excel/CSV export (saved as CSV) into the same listings table.
// Usage: node src/import-costar.js <file.csv | folder> [more...]
//
// CoStar caps each export at 500 rows, so a full market needs several files.
// Pass them all at once -- or just point at the folder holding them and every
// .csv inside is read, merged and de-duplicated in one pass.
//
// License note: CoStar data is for licensed users. Rows imported here are tagged
// source="costar" and costar_restricted so the portal can limit who sees them.
// The default portal query EXCLUDES source=costar unless you opt in.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { finalize } from "./lib/normalize.js";
import { getExisting, upsertListings, supabase } from "./lib/db.js";

// Brokers the crawler already collects directly. CoStar re-lists the same
// properties under its own names and URLs, so importing them would create
// near-duplicates the id hash cannot catch (different url|name|broker).
// CoStar's job is only to cover what we CANNOT crawl.
const ALREADY_CRAWLED = [
  /\becr\b|equitable commercial/i,
  /aquila/i,
  /\bhpi\b/i,
  /cushman/i,
  /kucera/i,
];

// Loose address key: "16235 N. IH-35" and "16235 N IH 35, Ste 200" collapse to
// the same thing. Suite/unit parts are dropped before comparing.
function addrKey(addr, city) {
  if (!addr) return null;
  const a = String(addr)
    .toLowerCase()
    .split(/\b(?:ste|suite|unit|bldg|building|#)\b/)[0]
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!a) return null;
  return `${a}|${String(city || "").toLowerCase().replace(/[^a-z]/g, "")}`;
}

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error("Usage: node src/import-costar.js <file.csv | folder> [more...]");
  process.exit(1);
}

// Expand any folder into the .csv files inside it.
const files = inputs.flatMap((p) => {
  if (!statSync(p).isDirectory()) return [p];
  return readdirSync(p)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => join(p, f));
});
if (!files.length) {
  console.error("No .csv files found in: " + inputs.join(", "));
  process.exit(1);
}

const pick = (row, ...names) => {
  for (const n of names) {
    const k = Object.keys(row).find((key) => key.toLowerCase().replace(/[^a-z]/g, "") === n);
    if (k && row[k]) return String(row[k]).trim();
  }
  return null;
};

const records = [];
for (const f of files) {
  const rows = parse(readFileSync(f), { columns: true, skip_empty_lines: true, relax_column_count: true });
  console.log(`  ${f}: ${rows.length} rows`);
  records.push(...rows);
}
console.log(`Read ${records.length} rows from ${files.length} file(s).`);
const today = new Date().toISOString().slice(0, 10);

let skippedBroker = 0;
const kept = records.filter((r) => {
  const co = pick(r, "listingcompany", "brokeragecompany", "company") || "";
  if (ALREADY_CRAWLED.some((re) => re.test(co))) { skippedBroker++; return false; }
  return true;
});
if (skippedBroker) {
  console.log(`Skipped ${skippedBroker} row(s) from brokers the crawler already covers.`);
}

const listings = kept.map((r) => {
  const l = finalize(
    {
      broker: pick(r, "listingcompany", "brokeragecompany", "company") || "CoStar (unattributed)",
      name: pick(r, "propertyname", "buildingname", "name") || pick(r, "propertyaddress", "address"),
      address: pick(r, "propertyaddress", "address", "streetaddress"),
      city: pick(r, "city") || "Austin",
      submarket: pick(r, "submarketname", "submarket", "submarketcluster"),
      type_text: pick(r, "propertytype", "spaceuse", "type"),
      status_text: pick(r, "listingtype", "forsaleorlease", "status") || "lease",
      size: pick(r, "rba", "availablesf", "totalavailablespacesf", "buildingsf", "size"),
      price_or_rate: pick(r, "rentsfyr", "askingrent", "salesprice", "price", "rate"),
      agents: [{ name: pick(r, "listingbrokeragent", "brokeragent", "agent"), phone: pick(r, "brokerphone", "phone"), email: null }],
      url: pick(r, "listingurl", "url"),
      image_url: null,
    },
    "costar"
  );
  return l;
});

const existing = await getExisting();

// Second guard: drop anything already in the table at the same address,
// whichever broker put it there.
const addrIndex = new Set();
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase
    .from("listings").select("address, city").neq("source", "costar").range(from, from + 999);
  if (error) throw error;
  for (const r of data) { const k = addrKey(r.address, r.city); if (k) addrIndex.add(k); }
  if (data.length < 1000) break;
}

let skippedAddr = 0;
const seen = new Set();
const rows = listings
  .filter((l) => l.name)
  .filter((l) => {
    const k = addrKey(l.address, l.city);
    if (k && addrIndex.has(k)) { skippedAddr++; return false; }
    return true;
  })
  .filter((l) => (seen.has(l.id) ? false : (seen.add(l.id), true)))
  .map((l) => ({
    ...l,
    first_seen: existing.get(l.id)?.first_seen ?? today,
    last_seen: today,
    is_new: !existing.has(l.id),
    active: true,
    updated_at: new Date().toISOString(),
  }));

await upsertListings(rows);
if (skippedAddr) {
  console.log(`Skipped ${skippedAddr} row(s) already listed at the same address by a crawled broker.`);
}
const dupes = listings.filter((l) => l.name).length - rows.length - skippedAddr;
console.log(`Imported ${rows.length} CoStar rows (${rows.filter((r) => r.is_new).length} new` +
            (dupes ? `, ${dupes} duplicate rows merged across exports` : "") + ").");
