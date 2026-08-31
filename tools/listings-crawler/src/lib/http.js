// Polite fetch helpers: real UA, retries, delays between requests.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 TMGListingsBot/1.0 (internal market research; manager@themorshedgroup.com)";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getText(url, { tries = 3, delayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
        redirect: "follow",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const finalUrl = res.url;
      const text = await res.text();
      return { text, finalUrl };
    } catch (e) {
      lastErr = e;
      await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

export async function getJson(url, opts = {}) {
  const { text } = await getText(url, opts);
  return JSON.parse(text);
}
