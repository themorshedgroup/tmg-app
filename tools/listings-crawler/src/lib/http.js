// Polite fetch helpers: real UA, retries, delays between requests.
// Identify honestly. The previous string impersonated Chrome, which some WAFs
// (ECR's among them) reject outright -- and it misrepresented who we are.
const UA =
  "TMGListingsBot/1.0 (+https://themorshedgroup.com; internal market research; manager@themorshedgroup.com)";

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
