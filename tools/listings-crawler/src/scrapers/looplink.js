// Stream Realty + Partners Real Estate — both use CoStar LoopLink white-label
// portals on their own subdomains. EXPERIMENTAL: LoopLink sits behind CoStar's
// WAF and intermittently returns "Access Denied" (observed Aug 2026). This
// scraper tries politely with a real browser and gives up cleanly on denial.
import { clean, mapType, mapStatus, isAustinMetro } from "../lib/normalize.js";
import { sleep } from "../lib/http.js";

const SOURCES = [
  { broker: "Stream Realty Partners", url: "https://looplink.streamrealty.com/", maxPages: 15 },
  {
    broker: "Partners Real Estate",
    url: "https://looplink.partnersrealestate.com/looplink/search/?sk=b143e97641363dc5018b321e51daae99&bb=ug5zkrjuwKzvuplnm0L",
    maxPages: 12,
  },
];

export async function scrape({ chromium }) {
  const browser = await chromium.launch({ headless: true });
  const out = [];
  const notes = [];
  try {
    for (const src of SOURCES) {
      const page = await browser.newPage({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      });
      try {
        await page.goto(src.url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await page.waitForTimeout(4000);
        const title = await page.title();
        if (/access denied|forbidden/i.test(title)) {
          notes.push(`${src.broker}: LoopLink access denied`);
          continue;
        }
        for (let p = 0; p < src.maxPages; p++) {
          const items = await page.evaluate(() => {
            const anchors = [...document.querySelectorAll("a[href*='/Listing/']")];
            const seen = new Set();
            return anchors
              .map((a) => {
                let card = a;
                for (let i = 0; i < 4 && card.parentElement; i++) {
                  card = card.parentElement;
                  if ((card.innerText || "").length > 60) break;
                }
                const href = a.href;
                if (seen.has(href)) return null;
                seen.add(href);
                const img = card.querySelector("img");
                return { href, txt: (card.innerText || "").replace(/\s+/g, " ").slice(0, 400), img: img ? img.src : null };
              })
              .filter(Boolean);
          });
          for (const it of items) {
            if (!isAustinMetro(it.txt) && !/austin/i.test(it.href)) continue;
            const name = clean(it.txt.split("|")[0].split(/ {2,}/)[0].slice(0, 90));
            out.push({
              broker: src.broker,
              name,
              address: (it.txt.match(/\d+[^,|]{3,50},\s*[A-Za-z ]+,\s*TX/) || [null])[0],
              city: (it.txt.match(/\b(Austin|Round Rock|Cedar Park|Georgetown|Pflugerville|Buda|Kyle|San Marcos|Leander|Hutto|Manor)\b/i) || ["Austin"])[0],
              submarket: null,
              property_type: mapType(it.txt),
              status: mapStatus(it.txt) || "for_lease",
              size: (it.txt.match(/[\d,]+\s*(?:-\s*[\d,]+\s*)?SF\b/i) || [null])[0],
              price_or_rate: (it.txt.match(/\$[\d,.]+[^|]{0,18}/) || [null])[0],
              agents: [],
              url: it.href,
              image_url: it.img,
            });
          }
          // Try the next-page control; stop when absent.
          const advanced = await page.evaluate(() => {
            const next = document.querySelector("a[aria-label*='Next'], .paging a.next, a[rel='next']");
            if (next) { next.click(); return true; }
            return false;
          });
          if (!advanced) break;
          await page.waitForTimeout(3500);
        }
      } catch (e) {
        notes.push(`${src.broker}: ${e.message}`);
      } finally {
        await page.close();
        await sleep(1000);
      }
    }
  } finally {
    await browser.close();
  }
  if (!out.length) throw new Error(`LoopLink: nothing captured (${notes.join("; ") || "no notes"})`);
  return out;
}
