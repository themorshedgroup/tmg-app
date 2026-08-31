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
import { getExisting, upsertListings } from "./lib/db.js";

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

const listings = records.map((r) => {
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
const seen = new Set();
const rows = listings
  .filter((l) => l.name)
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
const dupes = listings.filter((l) => l.name).length - rows.length;
console.log(`Imported ${rows.length} CoStar rows (${rows.filter((r) => r.is_new).length} new` +
            (dupes ? `, ${dupes} duplicate rows merged across exports` : "") + ").");
