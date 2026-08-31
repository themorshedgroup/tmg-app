// The Kucera Companies — Elementor + JetEngine listing grid, small Austin inventory.
// Verified structure (Aug 2026): kuceraco.com/austin-property-listings/ with
// .jet-listing-grid__item cards: h2.elementor-heading-title (street address as name),
// dynamic fields for "Austin TX, 78757", "office, medical_", submarket, link /property-listings/<slug>.
import * as cheerio from "cheerio";
import { getText } from "../lib/http.js";
import { clean, mapType } from "../lib/normalize.js";

const URL = "https://www.kuceraco.com/austin-property-listings/";

export async function scrape() {
  const { text } = await getText(URL);
  const $ = cheerio.load(text);
  const out = [];

  $(".jet-listing-grid__item").each((_, el) => {
    const c = $(el);
    const name = clean(c.find("h2").first().text());
    if (!name) return;
    const href = c.find("a[href*='/property-listings/']").first().attr("href") || URL;
    const img = c.find("img").first().attr("src") || c.find("img").first().attr("data-src");

    const fields = c
      .find(".jet-listing-dynamic-field__content")
      .map((_, f) => clean($(f).text()))
      .get()
      .filter(Boolean);
    const cityLine = fields.find((t) => /TX\b|texas|\b78\d{3}\b/i.test(t)) || "Austin TX";
    const typeLine = fields.find((t) => /office|retail|industrial|medical|flex|land|warehouse/i.test(t)) || "";
    const subLine = fields.find((t) => t.length < 25 && !/TX|78\d{3}|office|retail|industrial|medical|flex|land/i.test(t));

    out.push({
      broker: "The Kucera Companies",
      name,
      address: name,
      city: /round rock|cedar park|georgetown|pflugerville/i.test(cityLine) ? clean(cityLine.replace(/TX.*$/i, "")) : "Austin",
      submarket: subLine || null,
      property_type: mapType(typeLine),
      status: "for_lease", // Kucera cards don't publish status; portfolio is lease-focused
      size: null,
      price_or_rate: null,
      agents: [],
      url: href,
      image_url: img,
    });
  });

  if (!out.length) throw new Error("Kucera: no cards parsed — markup may have changed (grid may be JS-loaded)");
  return out;
}
