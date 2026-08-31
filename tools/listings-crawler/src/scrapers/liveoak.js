// Live Oak — Webflow site whose property grid populates client-side.
// EXPERIMENTAL: needs a real browser; extracts spotlight + grid cards after scroll.
import { clean, mapType, mapStatus } from "../lib/normalize.js";

export async function scrape({ chromium }) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto("https://www.liveoak.com/properties", { waitUntil: "networkidle", timeout: 60000 });
    await page.waitForTimeout(3000);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(800);
    }
    const items = await page.evaluate(() => {
      const links = [...document.querySelectorAll("a[href*='/spotlight/'], a[href*='/propert']")]
        .filter((a) => a.pathname !== "/properties");
      const seen = new Set();
      return links
        .map((a) => {
          if (seen.has(a.href)) return null;
          seen.add(a.href);
          let card = a;
          for (let i = 0; i < 3 && card.parentElement; i++) {
            if ((card.innerText || "").trim().length > 15) break;
            card = card.parentElement;
          }
          const img = card.querySelector("img");
          return { href: a.href, txt: (card.innerText || "").replace(/\s+/g, " ").slice(0, 250), img: img ? img.src : null };
        })
        .filter(Boolean);
    });
    const out = items
      .filter((it) => it.txt && it.txt.length > 3)
      .map((it) => ({
        broker: "Live Oak",
        name: clean(it.txt.split(/(?=[A-Z][a-z]+ \/)|\|/)[0].slice(0, 80)),
        address: null,
        city: "Austin",
        submarket: null,
        property_type: mapType(it.txt),
        status: mapStatus(it.txt) || "for_lease",
        size: (it.txt.match(/[\d,]+\s*(?:-\s*[\d,]+\s*)?SF\b/i) || [null])[0],
        price_or_rate: null,
        agents: [],
        url: it.href,
        image_url: it.img,
      }));
    if (!out.length) throw new Error("Live Oak: no property cards captured");
    return out;
  } finally {
    await browser.close();
  }
}
