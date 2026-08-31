// HPI Real Estate — server-rendered cards, paginated; covers Austin + DFW + San Antonio.
// Verified structure (Aug 2026): anchors containing .item-title (name),
// .item-address ("Market - Submarket"), .item-categories, .item-sf ("1,456-13,273 AVAILABLE SF").
import * as cheerio from "https://esm.sh/cheerio@1.0.0";
import { getText, sleep } from "../lib/http.js";
import { clean, mapType, mapStatus } from "../lib/normalize.js";

const BASE = "https://www.hpitx.com/properties/";
const MAX_PAGES = 12;

export async function scrape() {
  const out = [];
  const seen = new Set();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? BASE : `${BASE}page/${page}/`;
    let html;
    try {
      ({ text: html } = await getText(url, { tries: page === 1 ? 3 : 1 }));
    } catch {
      break;
    }
    const $ = cheerio.load(html);
    const cards = $("a").filter((_, el) => $(el).find(".item-title").length > 0);
    if (!cards.length && page > 1) break;

    cards.each((_, el) => {
      const c = $(el);
      const href = c.attr("href");
      const name = clean(c.find(".item-title").text());
      if (!name || !href || seen.has(href)) return;
      seen.add(href);

      const marketLine = clean(c.find(".item-address").text()) || "";
      const [market, submarket] = marketLine.split(/\s*-\s*/);
      const cats = clean(c.find(".item-categories").text()) || "";
      const sf = clean(c.find(".item-sf").text());
      const img = c.find("img").first().attr("src") || c.find("img").first().attr("data-src");
      if (/100%\s*(leased|sold)/i.test(c.text())) return;

      out.push({
        broker: "HPI Real Estate",
        name,
        address: null,
        city: clean(market),
        submarket: clean(submarket),
        property_type: mapType(cats || name),
        status: mapStatus(cats) || "for_lease",
        size: sf ? sf.replace(/\s*AVAILABLE\s*SF/i, " SF") : null,
        price_or_rate: null,
        agents: [],
        url: href.startsWith("http") ? href : `https://www.hpitx.com${href}`,
        image_url: img,
        _market: market || "",
      });
    });
    await sleep(1200);
  }

  if (!out.length) throw new Error("HPI: no cards parsed — markup may have changed");
  // Keep Austin market only (their address line starts with the market name)
  return out.filter((l) => {
    const keep = /austin|lockhart|round rock|cedar park|georgetown|pflugerville|san marcos|buda|kyle/i.test(l._market);
    delete l._market;
    return keep;
  });
}
