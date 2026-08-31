// JLL — property.jll.com search pages are robots-disallowed and JS-rendered,
// but individual listing pages are indexed and allowed. Discovery goes through
// the public sitemap; Austin listing URLs contain "-austin".
// Detail pages are Next.js: fields come from JSON-LD or __NEXT_DATA__.
import * as cheerio from "cheerio";
import { getText, sleep } from "../lib/http.js";
import { clean, mapType, mapStatus } from "../lib/normalize.js";

const HOST = "https://property.jll.com";
const MAX_DETAILS = 50;

async function collectSitemapUrls(url, depth = 0, acc = new Set()) {
  if (depth > 2 || acc.size > 5000) return acc;
  const { text } = await getText(url);
  const $ = cheerio.load(text, { xmlMode: true });
  const sitemaps = $("sitemap > loc").map((_, el) => $(el).text().trim()).get();
  const locs = $("url > loc").map((_, el) => $(el).text().trim()).get();
  locs.forEach((l) => acc.add(l));
  for (const sm of sitemaps) {
    if (/listing|propert/i.test(sm) || sitemaps.length <= 5) {
      await collectSitemapUrls(sm, depth + 1, acc);
      await sleep(800);
    }
  }
  return acc;
}

function fromJsonLd($) {
  for (const el of $("script[type='application/ld+json']").toArray()) {
    try {
      const data = JSON.parse($(el).text());
      const items = Array.isArray(data) ? data : [data];
      for (const d of items) {
        if (d && (d.address || d.name)) return d;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export async function scrape() {
  const all = await collectSitemapUrls(`${HOST}/sitemap.xml`);
  const austin = [...all].filter((u) => /\/listings\/.*austin/i.test(u)).slice(0, MAX_DETAILS);
  if (!austin.length) throw new Error("JLL: no Austin listing URLs found in sitemap");

  const out = [];
  for (const url of austin) {
    try {
      const { text } = await getText(url, { tries: 1 });
      const $ = cheerio.load(text);
      const ld = fromJsonLd($);
      const title = clean($("h1").first().text()) || clean(ld?.name) || clean($("title").text());
      if (!title) continue;
      const addr = ld?.address
        ? clean([ld.address.streetAddress, ld.address.addressLocality].filter(Boolean).join(", "))
        : null;
      const body = clean($("main").text() || $("body").text()) || "";
      out.push({
        broker: "JLL",
        name: title.replace(/\s*\|.*$/, ""),
        address: addr,
        city: ld?.address?.addressLocality || "Austin",
        submarket: null,
        property_type: mapType(`${url} ${body.slice(0, 400)}`),
        status: mapStatus(url) || mapStatus(body.slice(0, 400)) || "for_lease",
        size: (body.match(/[\d,]+\s*(?:-\s*[\d,]+\s*)?SF\b/i) || [null])[0],
        price_or_rate: (body.match(/\$[\d,.]+\s*(?:\/|per\s*)?SF[^\n]{0,20}/i) || [null])[0],
        agents: [],
        url,
        image_url: ld?.image ? (Array.isArray(ld.image) ? ld.image[0] : ld.image) : null,
      });
      await sleep(1500);
    } catch { /* skip individual failures */ }
  }

  if (!out.length) throw new Error("JLL: sitemap found but no detail pages parsed");
  return out;
}
