import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars.");
  process.exit(1);
}

export const supabase = createClient(url, key, { auth: { persistSession: false } });

export async function getExisting() {
  // id -> {first_seen, source} for diffing; paginate past the 1000-row default.
  const out = new Map();
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await supabase
      .from("listings")
      .select("id, first_seen, source")
      .range(from, from + page - 1);
    if (error) throw error;
    for (const row of data) out.set(row.id, row);
    if (data.length < page) break;
  }
  return out;
}

export async function upsertListings(rows) {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from("listings").upsert(rows.slice(i, i + 200));
    if (error) throw error;
  }
}

export async function deactivateMissing(seenIds, succeededSources, today) {
  // Only deactivate rows whose source scraper actually ran successfully this time.
  const { data, error } = await supabase
    .from("listings")
    .select("id, source")
    .eq("active", true);
  if (error) throw error;
  const gone = data
    .filter((r) => succeededSources.includes(r.source) && !seenIds.has(r.id))
    .map((r) => r.id);
  for (let i = 0; i < gone.length; i += 200) {
    const { error: e } = await supabase
      .from("listings")
      .update({ active: false, is_new: false, updated_at: new Date().toISOString() })
      .in("id", gone.slice(i, i + 200));
    if (e) throw e;
  }
  return gone.length;
}

export async function recordRun(totals, notes) {
  const { error } = await supabase.from("crawl_runs").insert({ totals, notes });
  if (error) console.error("crawl_runs insert failed:", error.message);
}
