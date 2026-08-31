# TMG Listings Crawler

Self-hosted crawler that pulls Austin-metro commercial listings (office, retail, industrial/flex, land, multifamily; lease and sale) from broker websites twice a week, stores them in Supabase, and feeds a TMG-branded portal page. Replaces the earlier Google Drive feed and needs no paid scraping service.

## How it works

GitHub Actions runs Monday and Thursday (9:00 AM Manila) → `src/index.js` runs each broker scraper → results are normalized to one schema, diffed against what's already in Supabase (stable ID per listing, `is_new` flag, disappeared listings marked inactive) → the portal reads the table through Supabase's built-in REST API with a read-only key.

## Setup (one time, ~15 minutes)

**1. Supabase (3 min).** In your Supabase project dashboard, open SQL Editor, paste the contents of `schema.sql`, click Run. Then go to Project Settings → API and copy three things: the Project URL, the `anon` public key, and the `service_role` secret key.

**2. GitHub (5 min).** Create a new **private** repository (e.g. `tmg-listings-crawler`) and upload this folder's contents, keeping the folder structure (the `.github/workflows/crawl.yml` path is what makes the schedule work). Then in the repo: Settings → Secrets and variables → Actions → New repository secret, twice:
   - `SUPABASE_URL` = the Project URL
   - `SUPABASE_SERVICE_KEY` = the `service_role` key (never put this one in frontend code)

**3. First run (2 min).** In the repo, open the Actions tab → "Crawl broker listings" → Run workflow. Watch it go green; the run summary prints listings per source. After this it fires automatically Mon/Thu.

**4. Portal (5 min).** Open `portal/portal.html`, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of the script (the anon key is designed to be public; row-level security limits it to reading active listings). Serve the file from the TMG app, or paste its contents into a route/iframe. Done.

## Sources and their reliability

| Source | Method | Reliability |
|---|---|---|
| ECR | fetch + selectors (verified Aug 2026) | high — richest data: rates, agents, suites |
| AQUILA | fetch + selectors (verified) | high |
| HPI | fetch + selectors (verified) | high |
| Cushman & Wakefield | fetch + selectors (verified); sale search redirects, lease-only | high |
| Kucera | fetch + selectors (verified) | medium — small JetEngine grid |
| Don Quick | fetch of their public Buildout plugin feed | medium-high |
| JLL | sitemap discovery → detail pages (robots-compliant) | medium |
| Stream Realty (LoopLink) | Playwright, experimental | low — CoStar WAF intermittently denies |
| Partners (LoopLink) | Playwright, experimental | low — same |
| Live Oak | Playwright, experimental | low — Webflow JS grid |
| CoStar export | manual: `npm run import:costar -- export.csv` | covers Newmark, Marcus & Millichap, Colliers, Avison Young, Endeavor, Lee & Associates |

Not covered: Kidder Mathews and ICO Commercial (no Austin inventory), CBRE and Transwestern (bot-protected JS apps; their Austin listings come through the CoStar export instead).

A failed source never wipes data: its previous listings stay active and the failure is logged in `crawl_runs` and the run artifact `crawl-report.json`. If a scraper fails twice in a row, the site probably changed its markup; the fix is usually a one-line selector update.

## CoStar imports

Run a saved Austin search in CoStar, Export to Excel, save as CSV, then locally: `SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run import:costar -- ~/Downloads/export.csv`. Rows are tagged `source=costar` and the portal excludes them by default (`INCLUDE_COSTAR = false`) because CoStar data may only be shown to licensed users. Flip that flag only if every portal viewer holds a seat.

## Conduct

The crawler only touches brokers' own public marketing pages, honors robots.txt (JLL search pages are disallowed, so it uses their sitemap and public detail pages instead), identifies itself in its user-agent, waits between requests, and runs twice a week. It does not log into anything, does not touch LoopNet/CoStar directly, and backs off cleanly when a site denies access.

## Local development

```
npm install
npx playwright install chromium
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run crawl        # full run
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run crawl:fetch-only  # skip browser scrapers
npm run check                                                   # syntax-check everything
```

Schedule changes: edit the cron line in `.github/workflows/crawl.yml` (times are UTC; 01:00 UTC = 9:00 AM Manila).
