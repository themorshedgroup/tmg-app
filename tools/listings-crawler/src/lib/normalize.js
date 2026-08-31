import { createHash } from "node:crypto";

export const AUSTIN_METRO = [
  "austin", "round rock", "cedar park", "georgetown", "pflugerville", "leander",
  "buda", "kyle", "san marcos", "lakeway", "bee cave", "bee caves", "west lake hills",
  "westlake", "dripping springs", "hutto", "manor", "del valle", "lockhart",
  "liberty hill", "spicewood", "elgin",
];

export function isAustinMetro(cityOrText) {
  if (!cityOrText) return false;
  const t = String(cityOrText).toLowerCase();
  return AUSTIN_METRO.some((c) => t.includes(c));
}

export function listingId(l) {
  const key = `${l.url || ""}|${l.name || ""}|${l.broker || ""}`.toLowerCase();
  return createHash("md5").update(key).digest("hex").slice(0, 12);
}

const TYPE_MAP = [
  [/office\s*\/?\s*retail|retail\s*\/?\s*office|mixed/i, "mixed"],
  [/office|medical/i, "office"],
  [/retail|restaurant/i, "retail"],
  [/industrial|warehouse|flex|manufactur|logistics/i, "industrial"],
  [/land|acre|development site|pad site/i, "land"],
  [/multi\s*-?\s*family|apartment/i, "multifamily"],
];

export function mapType(text) {
  if (!text) return "other";
  for (const [re, t] of TYPE_MAP) if (re.test(text)) return t;
  return "other";
}

export function mapStatus(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const lease = /lease|sublease|rent/.test(t);
  const sale = /sale|purchase/.test(t);
  if (lease && sale) return "both";
  if (sale) return "for_sale";
  if (lease) return "for_lease";
  return null;
}

export function clean(s) {
  return s == null ? null : String(s).replace(/\s+/g, " ").trim() || null;
}

// Final shape guard: every scraper's output passes through here.
export function finalize(l, source) {
  const out = {
    broker: clean(l.broker),
    name: clean(l.name),
    address: clean(l.address),
    city: clean(l.city),
    submarket: clean(l.submarket),
    property_type: l.property_type || mapType(`${l.type_text || ""}`),
    status: l.status || mapStatus(`${l.status_text || ""}`),
    size: clean(l.size),
    price_or_rate: clean(l.price_or_rate),
    agents: Array.isArray(l.agents) ? l.agents.filter((a) => a && a.name) : [],
    url: clean(l.url),
    image_url: clean(l.image_url),
    source,
  };
  out.id = listingId(out);
  return out;
}
