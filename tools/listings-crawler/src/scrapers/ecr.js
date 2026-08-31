// ECR (Equitable Commercial Realty) — server-rendered WordPress.
// Verified structure (Aug 2026): div.grid-cell > .property-photo (a, img),
// .property-info (h2.alt-b name, .submarket "CITY - SUBMARKET", .info "Type:/Status:"),
// .property-contact (agent names + phones), .property-details (suites table).
import * as cheerio from "cheerio";
import { getText } from "../lib/http.js";
import { clean, mapType, mapStatus } from "../lib/normalize.js";

const URL = "https://www.ecrtx.com/property-search/?market=4"; // market=4 = Austin

export async function scrape() {
  const { text } = await getText(URL);
  const $ = cheerio.load(text);
  const out = [];

  $(".grid-cell").each((_, cell) => {
    const c = $(cell);
    const name = clean(c.find("h2").first().text());
    if (!name) return;

    const sub = clean(c.find(".submarket").first().text()) || "";
    const [cityPart, subPart] = sub.split(/\s*-\s*/);
    const info = c.find(".property-info").text();
    const typeMatch = info.match(/Type:\s*([^\n]+)/i);
    const statusMatch = info.match(/Status:\s*([^\n]+)/i);
    if (statusMatch && /leased|sold/i.test(statusMatch[1]) && /100%|fully/i.test(info)) return;

    const href = c.find("a[href*='/properties/']").first().attr("href");
    const img = c.find(".property-photo img").first().attr("src");

    // Agents: "Contact: Name 512.xxx.xxxx Name2 512.xxx.xxxx"
    const agents = [];
    const contactTxt = clean(c.find(".property-contact").text()) || "";
    const agentRe = /([A-Z][\w.'-]+(?:\s+[A-Z][\w.',-]+){1,3}?)\s+((?:\d{3}[.\-]){2}\d{4})/g;
    let m;
    while ((m = agentRe.exec(contactTxt))) agents.push({ name: clean(m[1].replace(/^Contact:?\s*/i, "")), phone: m[2], email: null });

    // Suites table: sizes + rates
    const details = clean(c.find(".property-details").text()) || "";
    const sizes = details.match(/[\d,]+\s*(?:SF|AC|Acres?)/gi) || [];
    const rates = details.match(/\$[\d,.]+\s*(?:\/SF)?\s*(?:NNN|Modified Gross|MG|Gross|FS|\/mo)?/gi) || [];

    out.push({
      broker: "ECR",
      name,
      address: name, // ECR card titles are the street address
      city: clean(cityPart) ? clean(cityPart).replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/Austin.*/i, "Austin") : "Austin",
      submarket: clean(subPart),
      property_type: mapType(typeMatch ? typeMatch[1] : ""),
      status: mapStatus(statusMatch ? statusMatch[1] : "") || "for_lease",
      size: sizes.length ? [...new Set(sizes)].slice(0, 3).join(" / ") : null,
      price_or_rate: rates.length ? [...new Set(rates.map((r) => clean(r)))].slice(0, 2).join(" / ") : null,
      agents,
      url: href,
      image_url: img,
    });
  });

  if (!out.length) throw new Error("ECR: no cards parsed — markup may have changed");
  return out;
}
