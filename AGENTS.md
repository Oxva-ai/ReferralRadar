# AGENTS.md

## What ReferralRadar is

A standalone Node.js (Express 5, TypeScript strict, ESM) service that continuously discovers UK referral offers before they saturate the market. Deployed on Railway, database on Supabase (free tier). Feeds Easyearns.com via REST API. ~£0/month API costs, ~£4/month hosting.

30 TypeScript files, ~10,000 lines. 15 cron workers. 7 public API endpoints + 8 admin API endpoints.

## How discovery works

Five discovery sources feed a central processing pipeline:

1. **Serper + Brave search** (every 8 min) — generic "refer a friend UK" queries. Free tiers: Serper 2500/mo, Brave 2000/mo. No Google billing required.
2. **Reddit** (every 15 min + hourly) — 7 UK subreddits via `.json` URLs. R/beermoneyuk primary. Saturation detection (>50 upvotes + >20 comments = already popular).
3. **Competitor sites** (every 30 min) — LatestDeals, MagicFreebiesUK, Be Clever With Your Cash, Quidco, TopCashback. Cheerio HTML scraping. HotUKDeals and MSE excluded (Cloudflare JS challenge).
4. **RSS feeds** (30min/1h/2h by tier) — 10 feeds: altfi, uktn, finextra, crowdfundinsider, producthunt, hackernews, etc. Feed health tracked (3 consecutive empty runs = degraded, reported in /health).
5. **Brand-targeted search** (every 15 min) — searches each of 230+ UK brands by name on Serper. Only follows results on the brand's own domain. Rotates through the full list over multiple cycles.

Every URL discovered goes through:
1. **UK filter** — multi-signal gate: .co.uk TLD + GBP + geo text + FCA mentions. Decision matrix rejects non-UK content.
2. **Fetcher** — got (HTTP/2), rotating User-Agents, per-domain rate limiting (3s min), 15s timeout, 3 retries.
3. **Extractor** — cheerio HTML parsing, 10 groups of regex patterns, referral link scanning (12 patterns + script tag parser + meta tag parser), image alt text fallback, multi-offer splitting.
4. **Deduper** — 3 layers: exact URL match → content hash similarity > 0.85 → company+domain fuzzy match (levenshtein < 3). Merge/reactivate inactive matches. URL normalization strips www, tracking params. Same-domain same-source dedup within 1 hour.
5. **Quality gate** — blocks known spam domains, requires GBP amount OR referral link OR .co.uk domain, rejects junk company names.
6. **Brand resolution** — matches domain against 230+ UK brand directory, assigns cleaned company name and category.

## Schema (Supabase PostgreSQL)

9 tables: referrals, monitored_pages, offer_history, api_usage, submissions, worker_runs, app_config, click_events, impression_events, plus blocked_domains admin table.

Key columns on referrals: company_name, reward, reward_numeric, reward_type, referral_link, category, domain (generated), score, engagement_score, sources[], source_count, uk_signal_strength, discovered_at, last_verified_at, is_active.

Extensions: pgcrypto, pg_trgm, fuzzystrmatch. Custom functions: compute_score(), trim_worker_runs().

## API

**Public** (Easyearns consumes, auth via Bearer token):
- GET /referrals — scored, paginated, filterable (since, until, limit, offset, min_score, change_type, reward_type, min_value, has_link, sort)
- GET /referrals/top — top 20 highest-score this week
- GET /referrals/changed — terms changes only
- GET /referrals/stats — aggregate counts
- GET /referrals/:id — single referral with full detail
- POST /referrals/:id/click — record click (engagement feedback loop)
- POST /referrals/:id/impression — record display impression
- POST /submissions — user submitted lead (20/hr rate limit per user)

**Admin** (behind ADMIN_API_KEY):
- GET /admin/dashboard — full interactive HTML dashboard (tabs: Overview, Referrals, Workers, Blocklist)
- GET /admin/referrals/:id — full referral detail
- PATCH /admin/referrals/:id — edit company_name, reward, category
- DELETE /admin/referrals/:id — soft-delete referral
- POST /admin/referrals/batch-categorize — bulk category assignment
- GET /admin/workers/:name — worker run history (last 50)
- POST /admin/workers/:name/restart — trigger worker immediately
- GET /admin/blocklist — list blocked domains
- POST /admin/blocklist — add domain
- DELETE /admin/blocklist/:domain — remove domain

Response format includes brand, logo_url, has_link, category — Easyearns-ready.

## Deployment

- **Host**: Railway (minimum compute tier, ~£4/month)
- **Database**: Supabase free tier (500MB) via session pooler on port 5432
- **Build**: nixpacks via railway.toml (npm install && npm run build)
- **Start**: npm start (node dist/index.js)
- **Healthcheck**: /api/v1/health every 5 min via cron-job.org (prevents cold starts)
- **CI**: GitHub Actions (typecheck + vitest + build)
- **No Dockerfile** — it interferes with nixpacks. Deleted.

## Key constraints

- £0/month API budget — all free tiers
- No Puppeteer/headless browser (RAM too expensive)
- No Twitter/X ($100/month)
- No paid proxies
- No LLM-based extraction (API costs)
- UK market only
- Cloudflare-protected sites excluded (HotUKDeals, MSE, etc.)
- Supabase IPv6-only on direct connection — must use session pooler (aws-1-eu-central-2.pooler.supabase.com:5432)

## Known issues / watch points

- Reddit returns 403 sometimes — User-Agent rotation helps but not fully solved
- RSS feeds rot over time (AltFi, UKTN feeds already broken — need URL updates)
- Google CSE was abandoned (requires billing) — replaced with Serper + Brave
- `timingSafeEqual` requires equal-length buffers — auth middleware handles this
- Express route order matters: static routes (/changed, /top, /stats, /health) before /:id
- Admin dashboard uses key= query param for browser access + Authorization header for API
- In-memory mutex is process-local — fine for single-instance but not multi

## Colors (must match Easyearns)

Teal #0F766E primary, amber #D97706 accent, navy #1E293B text, coral #DC2626 errors. White bg, slate-50 (#F8FAFC) page bg, slate-200 (#E2E8F0) borders. Light theme.

## Env vars

DATABASE_URL, EASYEARNS_API_KEY, ADMIN_API_KEY, SERPER_API_KEY, BRAVE_API_KEY, GOOGLE_CSE_KEY (unused but kept), GOOGLE_CSE_ID (unused), CORS_ORIGINS, NODE_ENV, LOG_LEVEL. See .env.example.

## Running locally

```
cp .env.example .env    # fill in keys
npm run db:migrate      # once, against Supabase
npm run db:validate-seed  # once, check seed URLs
npm run db:seed         # once, insert monitored pages
npm run dev             # tsx watch src/index.ts
```

## Build & test

```
npm run build        # tsc
npm run typecheck    # tsc --noEmit
npm test             # vitest (39 unit tests)
```
