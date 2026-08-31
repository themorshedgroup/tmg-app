// Ingest a CoStar Excel/CSV export (saved as CSV) into the same listings table.
// Usage: node src/import-costar.js path/to/export.csv
//
// License note: CoStar data is for licensed users. Rows imported here are tagged
// source="costar" and costar_restricted so the portal can limit who sees them.
// The default portal query EXCLUDES source=costar unless you opt in.
import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { finalize } from "./lib/normalize.js";
import { getExisting, upsertListings } from "./lib/db.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node src/import-costar.js <export.csv>");
  process.exit(1);
}

const pick = (row, ...names) => {
  for (const n of names) {
    const k = Object.keys(row).find((key) => key.toLowerCase().replace(/[^a-z]/g, "") === n);
    if (k && row[k]) return String(row[k]).trim();
  }
  return null;
};

const records = parse(readFileSync(file), { columns: true, skip_empty_lines: true, relax_column_count: true });
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
const rows = listings
  .filter((l) => l.name)
  .map((l) => ({
    ...l,
    first_seen: existing.get(l.id)?.first_seen ?? today,
    last_seen: today,
    is_new: !existing.has(l.id),
    active: true,
    updated_at: new Date().toISOString(),
  }));

await upsertListings(rows);
console.log(`Imported ${rows.length} CoStar rows (${rows.filter((r) => r.is_new).length} new).`);
