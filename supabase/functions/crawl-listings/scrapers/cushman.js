// Cushman & Wakefield — server-rendered faceted search with clean city URLs.
// Verified structure (Aug 2026): .cw-search-card.js-property-card with
// __tag ("AVAILABLE FOR LEASE • OFFICE"), __title, __address, __price, img; pagination ?page=N.
// The /sale/ variant is known to redirect to a generic nationwide search — detected and skipped.
import * as cheerio from "https://esm.sh/cheerio@1.0.0";
import { getText, sleep } from "../lib/http.js";
import { clean, mapType, mapStatus } from "../lib/normalize.js";

const LEASE = "https://www.cushmanwakefield.com/en/united-states/properties/lease/search/texas/city-austin";
const SALE = "https://www.cushmanwakefield.com/en/united-states/properties/sale/search/texas/city-austin";
const MAX_PAGES = 10;

async function scrapeSearch(base, expectPath) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1 ? base : `${base}?page=${page}`;
    const { text: html, finalUrl } = await getText(url);
    if (expectPath && !finalUrl.includes(expectPath)) {
      if (page === 1) throw new Error(`redirected away (${finalUrl})`);
      break;
    }
    const $ = cheerio.load(html);
    const cards = $(".cw-search-card");
    if (!cards.length) break;

    cards.each((_, el) => {
      const c = $(el);
      const tag = clean(c.find("[class*='__tag']").text()) || "";
      const title = clean(c.find("[class*='__title']").text());
      const address = clean(c.find("[class*='__address']").text());
      const price = clean(c.find("[class*='__price']").text());
      const meta = clean(c.find("[class*='__meta']").text());
      const img = c.find("img").first().attr("src") || c.find("img").first().attr("data-src");
      const href = c.closest("a").attr("href") || c.find("a").first().attr("href") || c.parent("a").attr("href");
      if (!title) return;

      out.push({
        broker: "Cushman & Wakefield",
        name: title,
        address,
        city: address && /,\s*([A-Za-z .]+),\s*Texas/i.test(address) ? address.match(/,\s*([A-Za-z .]+),\s*Texas/i)[1] : "Austin",
        submarket: null,
        property_type: mapType(tag),
        status: mapStatus(tag),
        size: meta && /SF|acre/i.test(meta) ? meta : null,
        price_or_rate: price ? price.replace(/^(Rental|Sale)\s*Price:\s*/i, "") : null,
        agents: [],
        url: href ? (href.startsWith("http") ? href : `https://www.cushmanwakefield.com${href}`) : null,
        image_url: img,
      });
    });
    await sleep(1500);
  }
  return out;
}

export async function scrape() {
  const lease = await scrapeSearch(LEASE, "city-austin");
  let sale = [];
  try {
    sale = await scrapeSearch(SALE, "city-austin");
  } catch {
    // sale search redirects — known site limitation, lease-only is expected
  }
  const out = [...lease, ...sale];
  if (!out.length) throw new Error("C&W: no cards parsed — markup may have changed");
  return out;
}
