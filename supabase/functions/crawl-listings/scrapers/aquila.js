// AQUILA Commercial — server-rendered WordPress grid, paginated.
// Verified structure (Aug 2026): .row > div.columns cards, each with
// a[href*="/property/"], img, span.flag (status/"Featured"), h4 (name),
// p with <br>-separated lines: address / "Office, Retail Space For Lease" / "62,127 SF available" / submarket.
import * as cheerio from "https://esm.sh/cheerio@1.0.0";
import { getText, sleep } from "../lib/http.js";
import { clean, mapType, mapStatus, isAustinMetro } from "../lib/normalize.js";

const BASE = "https://aquilacommercial.com/property-search/";
const MAX_PAGES = 25;

export async function scrape() {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? BASE : `${BASE}page/${page}/`;
    let html;
    try {
      ({ text: html } = await getText(url, { tries: page === 1 ? 3 : 1 }));
    } catch {
      break; // past the last page
    }
    const $ = cheerio.load(html);
    const cards = $("div.columns").filter((_, el) => $(el).find("a[href*='/property/']").length > 0);
    if (!cards.length) break;

    cards.each((_, el) => {
      const c = $(el);
      const href = c.find("a[href*='/property/']").first().attr("href");
      const name = clean(c.find("h4").first().text());
      if (!name || !href) return;

      const pHtml = c.find("p").first().html() || "";
      const lines = pHtml.split(/<br\s*\/?>/i).map((s) => clean(cheerio.load(`<x>${s}</x>`)("x").text())).filter(Boolean);
      // lines: [address, "Office, Retail Space For Lease|Sale", "62,127 SF available", submarket]
      const address = lines[0] || null;
      const typeStatus = lines.find((l) => /lease|sale/i.test(l)) || "";
      const size = lines.find((l) => /\bSF\b|acre/i.test(l)) || null;
      const submarket = lines.length > 1 ? lines[lines.length - 1] : null;
      const flag = clean(c.find(".flag").text());
      const img = c.find("img").first().attr("src") || c.find("img").first().attr("data-src");

      out.push({
        broker: "AQUILA Commercial",
        name,
        address,
        city: "Austin", // grid shows submarket, not city; site is Austin-focused (non-metro filtered below by name/address)
        submarket: submarket && !/lease|sale|SF/i.test(submarket) ? submarket : null,
        property_type: mapType(typeStatus),
        status: mapStatus(typeStatus) || mapStatus(flag),
        size: size ? size.replace(/\s*available\s*/i, "") : null,
        price_or_rate: null, // not published on cards
        agents: [],
        url: href,
        image_url: img,
        _metro_text: `${address || ""} ${submarket || ""}`,
      });
    });
    await sleep(1200);
  }

  if (!out.length) throw new Error("AQUILA: no cards parsed — markup may have changed");
  // Drop obvious non-metro (Temple, Waco, etc. appear with city names in the address line)
  return out.filter((l) => {
    const t = `${l._metro_text}`.toLowerCase();
    const nonMetro = /(temple|waco|killeen|schertz|taylor|bastrop|jarrell|copperas cove|new braunfels|seguin)/i.test(t);
    delete l._metro_text;
    return !nonMetro;
  });
}
