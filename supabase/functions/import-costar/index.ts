// ─────────────────────────────────────────────────────────────────────────
// TMG App — Supabase Edge Function: import-costar
// In-app CoStar import. The browser cannot write to `listings` (RLS grants
// authenticated SELECT only; writes are service-role), so the upload comes
// here, is validated, and is written with the service key.
//
// Deploy: `supabase functions deploy import-costar`  (Verify JWT ON —
//   only signed-in staff may import; the caller's profile is checked too.)
//
// Accepts .xlsx or .csv as multipart/form-data field "file". SheetJS reads
// both, so nobody has to convert an Excel export by hand.
//
// Mapping mirrors tools/listings-crawler/src/import-costar.js — CoStar's real
// column names, lease/sale derived from which price has a value, overlap with
// already-crawled brokers dropped, and CoStar's Property ID preferred as the
// stable id. Keep the two in step if either changes.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { createHash } from "node:crypto";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });

const COMPANY_FIELDS = ["leasingcompanyname", "salecompanyname", "listingcompany", "brokeragecompany", "company"];
const CONTACT_FIELDS = ["leasingcompanycontact", "salecompanycontact", "listingbrokeragent", "brokeragent", "agent"];
const ALREADY_CRAWLED = [/\becr\b|equitable commercial/i, /aquila/i, /\bhpi\b/i, /cushman/i, /kucera/i];

const norm = (k: string) => k.toLowerCase().replace(/[^a-z]/g, "");
function pick(row: Record<string, unknown>, ...names: string[]) {
  for (const n of names) {
    const k = Object.keys(row).find((key) => norm(key) === n);
    if (k && row[k] != null && String(row[k]).trim() !== "") return String(row[k]).trim();
  }
  return null;
}
const clean = (s: string | null) => (s == null ? null : String(s).replace(/\s+/g, " ").trim() || null);

const TYPE_MAP: [RegExp, string][] = [
  [/office\s*\/?\s*retail|retail\s*\/?\s*office|mixed/i, "mixed"],
  [/office|medical/i, "office"],
  [/retail|restaurant/i, "retail"],
  [/industrial|warehouse|flex|manufactur|logistics/i, "industrial"],
  [/land|acre|development site|pad site/i, "land"],
  [/multi\s*-?\s*family|apartment/i, "multifamily"],
];
const mapType = (t: string | null) => {
  if (!t) return "other";
  for (const [re, v] of TYPE_MAP) if (re.test(t)) return v;
  return "other";
};

function addrKey(addr: string | null, city: string | null) {
  if (!addr) return null;
  const a = String(addr).toLowerCase()
    .split(/\b(?:ste|suite|unit|bldg|building|#)\b/)[0]
    .replace(/[^a-z0-9]+/g, " ").trim();
  if (!a) return null;
  return `${a}|${String(city || "").toLowerCase().replace(/[^a-z]/g, "")}`;
}
const md5 = (s: string) => createHash("md5").update(s).digest("hex").slice(0, 12);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Who is calling? Verify_jwt already rejected anonymous callers; confirm the
  // user is a real staff profile before letting them write to shared data.
  const authHeader = req.headers.get("Authorization") || "";
  const asUser = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: auth } = await asUser.auth.getUser();
  if (!auth?.user) return json({ error: "Not signed in." }, 401);

  const sb = createClient(url, svcKey, { auth: { persistSession: false } });
  const { data: prof } = await sb.from("profiles").select("id,status").eq("id", auth.user.id).maybeSingle();
  if (!prof || prof.status !== "active") return json({ error: "Not an active staff account." }, 403);

  let rows: Record<string, unknown>[] = [];
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return json({ error: "No file uploaded." }, 400);
    const buf = new Uint8Array(await file.arrayBuffer());
    const wb = XLSX.read(buf, { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return json({ error: "That file has no readable sheet." }, 400);
    rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
  } catch (e) {
    return json({ error: `Could not read that file: ${e instanceof Error ? e.message : String(e)}` }, 400);
  }
  if (!rows.length) return json({ error: "That file has no rows." }, 400);

  let skippedBroker = 0;
  const kept = rows.filter((r) => {
    const co = pick(r, ...COMPANY_FIELDS) || "";
    if (ALREADY_CRAWLED.some((re) => re.test(co))) { skippedBroker++; return false; }
    return true;
  });

  const today = new Date().toISOString().slice(0, 10);
  const mapped = kept.map((r) => {
    const rent = pick(r, "rentsf", "rentsfyr", "askingrent", "rate");
    const sale = pick(r, "forsaleprice", "salesprice", "price");
    const saleOff = /not for sale|off market/i.test(pick(r, "forsalestatus") || "");
    const forSale = !!sale && !saleOff;
    const sizeRaw = pick(r, "totalavailablespacesf", "rentablebuildingarea", "rba", "availablesf", "buildingsf", "size");
    const sizeNum = sizeRaw ? Number(String(sizeRaw).replace(/[^0-9.]/g, "")) : NaN;
    const address = clean(pick(r, "propertyaddress", "address", "streetaddress"));
    const name = clean(pick(r, "propertyname", "buildingname", "name")) || address;
    const broker = clean(pick(r, ...COMPANY_FIELDS)) || "CoStar (unattributed)";
    const listingUrl = clean(pick(r, "listingurl", "url"));
    const costarId = pick(r, "propertyid", "costarpropertyid", "propertyidno", "costarid");

    const l: Record<string, unknown> = {
      broker, name, address,
      city: clean(pick(r, "city")) || "Austin",
      submarket: clean(pick(r, "submarketname", "submarket", "submarketcluster")),
      property_type: mapType(pick(r, "propertytype", "secondarytype", "spaceuse", "type")),
      status: rent && forSale ? "both" : forSale ? "for_sale" : rent ? "for_lease" : null,
      size: Number.isFinite(sizeNum) && sizeNum > 0 ? `${sizeNum.toLocaleString("en-US")} SF` : sizeRaw,
      price_or_rate: clean(rent || sale),
      agents: [{ name: clean(pick(r, ...CONTACT_FIELDS)), phone: clean(pick(r, "brokerphone", "phone")), email: null }]
        .filter((a) => a.name),
      url: listingUrl,
      image_url: null,
      source: "costar",
      raw: costarId ? { costar_property_id: costarId } : null,
    };
    l.id = costarId
      ? md5(`costar:${costarId}`)
      : listingUrl
        ? md5(`${listingUrl}|${name || ""}|${broker}`.toLowerCase())
        : md5(`costar|${address || ""}|${name || ""}|${broker}`.toLowerCase());
    return l;
  }).filter((l) => l.name);

  // Drop anything already listed at the same address by a crawled broker.
  const addrIndex = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("listings")
      .select("address, city").neq("source", "costar").range(from, from + 999);
    if (error) return json({ error: error.message }, 500);
    for (const r of data) { const k = addrKey(r.address, r.city); if (k) addrIndex.add(k); }
    if (data.length < 1000) break;
  }

  const existing = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from("listings")
      .select("id").eq("source", "costar").range(from, from + 999);
    if (error) return json({ error: error.message }, 500);
    for (const r of data) existing.add(r.id);
    if (data.length < 1000) break;
  }

  let skippedAddr = 0;
  const seen = new Set<string>();
  const payload = mapped
    .filter((l) => {
      const k = addrKey(l.address as string, l.city as string);
      if (k && addrIndex.has(k)) { skippedAddr++; return false; }
      return true;
    })
    .filter((l) => (seen.has(l.id as string) ? false : (seen.add(l.id as string), true)))
    .map((l) => ({ ...l, first_seen: today, last_seen: today, is_new: !existing.has(l.id as string), active: true, updated_at: new Date().toISOString() }));

  for (let i = 0; i < payload.length; i += 200) {
    const { error } = await sb.from("listings").upsert(payload.slice(i, i + 200));
    if (error) return json({ error: error.message }, 500);
  }

  return json({
    ok: true,
    read: rows.length,
    imported: payload.length,
    new: payload.filter((r) => r.is_new).length,
    skipped_already_crawled: skippedBroker,
    skipped_same_address: skippedAddr,
    merged_duplicates: mapped.length - payload.length - skippedAddr,
  });
});
