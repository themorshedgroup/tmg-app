// Don Quick & Associates — listings served by an embedded Buildout plugin iframe.
// Discovered (Aug 2026): https://buildout.com/plugins/428cddd27f74d200d2ba40cba776a7627c18f014/donquick.com/inventory/
// Buildout inventory pages are server-rendered; markup is Buildout's standard grid.
// This parser is heuristic (repeated-card detection) so minor Buildout redesigns don't kill it.
import * as cheerio from "cheerio";
import { getText, sleep } from "../lib/http.js";
import { clean, mapType, mapStatus } from "../lib/normalize.js";

const KEY = "428cddd27f74d200d2ba40cba776a7627c18f014";
const BASE = `https://buildout.com/plugins/${KEY}/donquick.com/inventory/`;
const MAX_PAGES = 6;

function parseCards($) {
  // Find the most repeated element class that contains a link and a decent amount of text.
  const counts = new Map();
  $("div, article, li").each((_, el) => {
    const cls = ($(el).attr("class") || "").trim();
    if (cls) counts.set(cls, (counts.get(cls) || 0) + 1);
  });
  const candidates = [...counts.entries()]
    .filter(([, n]) => n >= 3 && n <= 200)
    .sort((a, b) => b[1] - a[1]);

  for (const [cls] of candidates) {
    const sel = "." + cls.split(/\s+/).join(".");
    let els;
    try { els = $(sel); } catch { continue; }
    const sample = els.first();
    if (sample.find("a").length && clean(sample.text() || "").length > 40) {
      return els;
    }
  }
  return $([]);
}

export async function scrape() {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = page === 0 ? BASE : `${BASE}?page=${page}`;
    let html;
    try {
      ({ text: html } = await getText(url, { tries: page === 0 ? 3 : 1 }));
    } catch {
      break;
    }
    const $ = cheerio.load(html);
    const cards = parseCards($);
    if (!cards.length) break;

    let added = 0;
    cards.each((_, el) => {
      const c = $(el);
      const a = c.find("a[href]").first();
      const href = a.attr("href");
      const txt = clean(c.text()) || "";
      const name = clean(c.find("h1,h2,h3,h4,h5,strong").first().text()) || clean(a.text());
      if (!name || name.length < 3) return;
      const img = c.find("img").first().attr("src") || c.find("img").first().attr("data-src");
      const size = (txt.match(/[\d,.]+\s*(?:SF|Acres?|AC)\b/i) || [null])[0];
      const price = (txt.match(/\$[\d,.]+(?:\s*\/\s*(?:SF|mo|month|yr))?(?:\s*(?:NNN|MG|Gross|FS))?/i) || [null])[0];
      const cityMatch = txt.match(/\b(Austin|Round Rock|Cedar Park|Georgetown|Pflugerville|Leander|Hutto|Taylor|Manor)\b/i);

      out.push({
        broker: "Don Quick & Associates",
        name,
        address: null,
        city: cityMatch ? cityMatch[1] : "Round Rock",
        submarket: null,
        property_type: mapType(txt),
        status: mapStatus(txt) || "for_lease",
        size,
        price_or_rate: price,
        agents: [],
        url: href ? new URL(href, BASE).toString() : BASE,
        image_url: img ? new URL(img, BASE).toString() : null,
      });
      added++;
    });
    if (!added) break;
    await sleep(1500);
  }

  if (!out.length) throw new Error("Don Quick (Buildout): no cards parsed — plugin markup may have changed");
  // Dedupe by url+name (heuristic card detection can double-match nested nodes)
  const seen = new Set();
  return out.filter((l) => {
    const k = `${l.url}|${l.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
