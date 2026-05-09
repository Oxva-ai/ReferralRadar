# AGENTS.md

## What ReferralRadar is

A standalone Node.js (Express 5, TypeScript strict, ESM) service that continuously discovers UK referral offers before they saturate the market. Deployed on Railway, database on Supabase (free tier). Feeds Easyearns.com via REST API. ~£0/month API costs, ~£4/month hosting.

~40 TypeScript files. 13 cron workers. 10 public API endpoints + 19 admin API endpoints. 52 unit tests + 9 DB integration tests.

## How discovery works

Five discovery sources feed a central processing pipeline:

1. **Serper + Brave search** (every 8 min) — generic "refer a friend UK" queries. Free tiers tracked via quota-tracker: Serper 83/day, Brave 66/day. No Google billing required.
2. **Reddit** (every 15 min + hourly) — 7 UK subreddits via `.json` URLs. R/beermoneyuk primary. Post IDs persisted to `reddit_processed_posts` table. Saturation detection (>50 upvotes + >20 comments = already popular).
3. **Competitor sites** (every 30 min) — LatestDeals, MagicFreebiesUK, Be Clever With Your Cash, Quidco, TopCashback. Cheerio HTML scraping. HotUKDeals and MSE excluded (Cloudflare JS challenge).
4. **RSS feeds** (30min/1h/2h by tier) — 10 feeds. Feed health persisted to `app_config` (survives restart). Degraded feeds reported in /health.
5. **Brand-targeted search** (every 6 hours) — searches 208 UK brands by name on Serper (3 per cycle). Only follows results on the brand's own domain. Brand index persisted to `app_config`.

Every URL discovered goes through:
1. **UK filter** — multi-signal gate: .co.uk TLD + GBP + geo text + FCA mentions. Decision matrix rejects non-UK content.
2. **Fetcher** — got (HTTP/2), rotating User-Agents, per-domain rate limiting (3s min), 15s timeout, circuit breaker (5 failures = 5 min cooldown).
3. **Extractor** — cheerio HTML parsing, 10 reward pattern groups, referral link scanning (12 patterns + script tag parser + meta tag parser), image alt text fallback, multi-offer splitting. Extracts 17 fields including referrer/referee reward, offer summary, referral code, terms URL, expires date, confidence score.
4. **Deduper** — 3 layers: exact URL match → content hash similarity > 0.85 → company+domain fuzzy match (levenshtein < 3). Merge/reactivate inactive matches. URL normalization strips www, tracking params. Same-domain same-source dedup within 1 hour. Aggregator detection (3+ unique GBP amounts = flag).
5. **Quality gate** — blocks known spam domains (DB-backed + static fallback), requires GBP amount OR referral link OR .co.uk domain, rejects junk company names.
6. **Brand resolution** — matches domain against 208-UK-brand directory in DB (loaded at startup with static fallback), assigns cleaned company name and category.

## Schema (Supabase PostgreSQL)

16 tables: referrals, monitored_pages, offer_history, api_usage, submissions, worker_runs, app_config, click_events, impression_events, blocked_domains, brands, webhooks, webhook_deliveries, reddit_processed_posts, queue_jobs, dead_letter_queue, search_queries.

RLS enabled on all 16 tables. Pool connects via database owner role (bypasses RLS). Anon/authenticated roles blocked.

Extensions: pgcrypto, pg_trgm, fuzzystrmatch. Custom functions: compute_score() (source rarity factor added), trim_worker_runs().

Key columns on referrals: company_name, reward, reward_numeric, reward_type, referral_link, category, domain (generated), score, engagement_score, sources[], source_count, uk_signal_strength, confidence, review_status, referee_reward, referrer_reward, offer_summary, referral_code, terms_url, is_instant, is_no_id, is_gambling, requires_spending, is_aggregator, discovered_at, last_verified_at, is_active.

## API

**Public** (Easyearns consumes, auth via Bearer token):
- GET /referrals — scored, paginated, filterable (since, until, limit, offset, min_score, change_type, reward_type, min_value, has_link, sort)
- GET /referrals/top — top 20 highest-score this week
- GET /referrals/changed — terms changes only
- GET /referrals/stats — aggregate counts + quota status
- GET /referrals/categories — category breakdown with counts
- GET /referrals/easyearns?since= — batch sync endpoint for Easyearns (cursor-based)
- GET /referrals/:id — single referral with full detail
- POST /referrals/:id/click — record click (1-day dedup)
- POST /referrals/:id/impression — record impression (1-day dedup)
- POST /submissions — user submitted URL (20/hr rate limit, DB-backed)

**Admin** (behind ADMIN_API_KEY):
- GET /admin/dashboard — full interactive HTML dashboard
- GET /admin/referrals/:id — full referral detail
- PATCH /admin/referrals/:id — edit company_name, reward, category
- DELETE /admin/referrals/:id — soft-delete referral
- POST /admin/referrals/batch-categorize — bulk category assignment
- PATCH /admin/referrals/:id/review — set review status (pending/approved/rejected/needs_fix)
- GET /admin/referrals/pending-review — list referrals needing review
- POST /admin/referrals/auto-approve — bulk approve by confidence threshold
- GET /admin/workers/:name — worker run history (last 50)
- POST /admin/workers/:name/restart — trigger worker immediately
- GET /admin/blocklist — list blocked domains
- POST /admin/blocklist — add domain
- DELETE /admin/blocklist/:domain — remove domain
- POST /admin/brands/reload — reload brand directory from DB
- GET /admin/webhooks — list webhooks
- POST /admin/webhooks — register webhook (events[], optional secret)
- DELETE /admin/webhooks/:id — remove webhook
- GET /admin/webhooks/:id/deliveries — delivery history
- POST /admin/keys/rotate — rotate API key (7-day grace period)
- GET /admin/keys/status — key rotation status

Response format includes 20+ fields: brand, logo_url, category, score, confidence, review_status, first_source, has_link, referee_reward, referrer_reward, offer_summary, referral_code, terms_url, is_instant, is_no_id, is_gambling, requires_spending — Easyearns-ready.

All API responses include `X-API-Version: 1.0.0` header. HTTP caching headers set on read endpoints.

## Deployment

- **Host**: Railway (minimum compute tier, ~£4/month)
- **Database**: Supabase free tier (500MB) via session pooler on port 5432
- **Build**: nixpacks via railway.toml (npm install && npm run build)
- **Start**: npm start (node dist/index.js)
- **Healthcheck**: /api/v1/health every 5 min via cron-job.org (prevents cold starts)
- **CI**: GitHub Actions — Postgres 15 service → migrations → typecheck → 52 unit tests → 9 integration tests → build
- **DB pool**: max 5 connections (Supabase free tier limit)
- **No Dockerfile** — it interferes with nixpacks. Deleted.

## Key constraints

- £0/month API budget — all free tiers
- No Puppeteer/headless browser (RAM too expensive)
- No Twitter/X ($100/month)
- No paid proxies
- No LLM-based extraction (API costs)
- UK market only
- Cloudflare-protected sites excluded (HotUKDeals, MSE, etc.)
- Supabase IPv6-only on direct connection — must use session pooler

## Known issues / watch points

- Reddit returns 403 sometimes — User-Agent rotation helps but not fully solved
- RSS feeds rot over time (AltFi, UKTN feeds already broken — need URL updates)
- `timingSafeEqual` requires equal-length buffers — auth middleware handles this
- Express route order matters: static routes (/changed, /top, /stats, /health, /categories, /easyearns) before /:id
- Admin dashboard loads via `?key=` query param (browsers can't set Authorization on page loads). All subsequent JS API calls use Authorization: Bearer header.
- Brands loaded from DB at startup with static fallback for offline/test environments
- Queue is Postgres-backed (`FOR UPDATE SKIP LOCKED`) — survives restarts, auto-recovers stuck jobs
- Blocklist is DB-backed (`blocked_domains`) with static fallback

## Colors (must match Easyearns)

Teal #0F766E primary, amber #D97706 accent, navy #1E293B text, coral #DC2626 errors. White bg, slate-50 (#F8FAFC) page bg, slate-200 (#E2E8F0) borders. Light theme.

## Env vars

DATABASE_URL, EASYEARNS_API_KEY, ADMIN_API_KEY, SERPER_API_KEY, BRAVE_API_KEY, LOGO_DEV_TOKEN, CORS_ORIGINS, EASYEARNS_STAGING_ORIGINS, REFERRAL_RETENTION_DAYS, EVENT_RETENTION_DAYS, KEY_ROTATION_GRACE_DAYS, NODE_ENV, LOG_LEVEL. See .env.example.

## Running locally

```
cp .env.example .env    # fill in keys
npm run db:migrate      # once, against Supabase
npm run db:seed         # once, insert monitored pages
npm run dev             # tsx watch src/index.ts
```

## Build & test

```
npm run build           # tsc
npm run typecheck       # tsc --noEmit
npm test                # vitest (52 unit tests)
npm run test:integration  # vitest (9 DB-backed integration tests, needs Postgres)
```
