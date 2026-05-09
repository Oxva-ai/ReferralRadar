# ReferralRadar

A standalone Node.js service that continuously discovers UK referral offers before they hit the mainstream. Feeds [Easyearns.com](https://easyearns.com) with fresh, scored referral data via REST API.

**Budget**: £0/month for APIs, ~£4/month hosting (Railway + Supabase free tier)

---

## What it does

ReferralRadar monitors 7+ discovery channels to find UK referral programmes the moment they appear — not after they've been posted to aggregator sites. Every discovered URL goes through a pipeline: UK market gate, HTML extraction, deduplication, quality scoring, brand resolution, and storage.

### What it finds

| Type | Example |
|------|---------|
| New referral offers | A fintech launches a refer-a-friend page |
| Terms changes | Monzo increases referral reward from £5 to £20 |
| Undiscovered programmes | A small brand's `/refer-a-friend` found via URL guessing |
| Live referral codes | `monzo.com/refer?code=abc123` extracted from pages |

---

## How discovery works

Five parallel discovery sources feed a central processing pipeline:

| Source | Frequency | Method |
|--------|-----------|--------|
| Serper + Brave search | Every 8 min | Generic referral queries (UK-targeted) |
| Brand-targeted search | Every 6 hours | 208 UK brands searched by name |
| Reddit | Every 15 min | 7 UK subreddits via `.json` URLs |
| Competitor sites | Every 30 min | Cheerio HTML scraping (LatestDeals, Quidco, etc.) |
| RSS feeds | 30min/1h/2h tiers | 10 feeds (fintech, startup, product news) |

### Pipeline

Every URL discovered goes through:

1. **UK filter** — Multi-signal gate (.co.uk TLD, GBP currency, UK geo text, FCA mentions). Rejects non-UK content.
2. **Fetcher** — `got` (HTTP/2), rotating user-agents, per-domain rate limiting (3s min), 15s timeout, circuit breaker (5 failures = 5 min cooldown).
3. **Extractor** — Cheerio HTML parsing, 10 reward pattern groups, referral link scanning (12 regex patterns), script tag + meta tag parsers, image alt text fallback, multi-offer splitting.
4. **Deduplicator** — 3 layers: exact URL match → content hash similarity > 0.85 → company + domain fuzzy match (Levenshtein < 3). Same-domain same-source within 1h.
5. **Quality gate** — Blocks known spam domains, requires GBP amount or referral link or .co.uk, rejects junk company names.
6. **Brand resolution** — Matches domain against 208-brand directory, assigns cleaned company name and category.
7. **Scoring** — Weighted algorithm: freshness, novelty, reward value, UK signal strength, engagement. Scores materialised every 15 min.

---

## Scoring

Referrals are scored 0-1 based on five weighted factors:

| Factor | Weight | What it measures |
|--------|--------|------------------|
| Freshness | 25% | How recently discovered (decays over 30 days) |
| Novelty | 20% | Fewer sources = more novel (undiscovered) |
| Value | 20% | Higher reward amounts score better |
| UK signal | 10% | Stronger UK signals = more relevant |
| Engagement | 25% | Click-through rate on displayed offers |

---

## API

### Public endpoints (Easyearns consumes these)

| Endpoint | Description |
|----------|-------------|
| `GET /referrals` | Scored, paginated, filterable list |
| `GET /referrals/top` | Top 20 highest-score this week |
| `GET /referrals/changed` | Terms changes only |
| `GET /referrals/stats` | Aggregate counts and quota status |
| `GET /referrals/categories` | Category breakdown with counts |
| `GET /referrals/easyearns?since=` | Batch sync endpoint for Easyearns |
| `GET /referrals/:id` | Single referral with full detail |
| `POST /referrals/:id/click` | Record click (engagement feedback) |
| `POST /referrals/:id/impression` | Record impression |
| `POST /submissions` | User-submitted URL (20/hr rate limit) |

### Admin endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /admin/dashboard` | Interactive HTML dashboard |
| `PATCH /admin/referrals/:id` | Edit company, reward, category |
| `DELETE /admin/referrals/:id` | Soft-delete referral |
| `POST /admin/referrals/batch-categorize` | Bulk category assignment |
| `GET /admin/workers/:name` | Worker run history |
| `POST /admin/workers/:name/restart` | Trigger worker immediately |
| `GET /admin/blocklist` | List blocked domains |
| `POST /admin/blocklist` | Add domain to blocklist |
| `POST /admin/brands/reload` | Reload brand directory from DB |
| `GET/POST/DELETE /admin/webhooks` | Webhook management |

---

## Tech stack

- **Runtime**: Node.js 22+, TypeScript strict, ESM
- **Framework**: Express 5
- **Database**: Supabase PostgreSQL (pgcrypto, pg_trgm, fuzzystrmatch)
- **HTTP**: `got` (HTTP/2, retry, circuit breaker)
- **Scraping**: Cheerio
- **Scheduling**: node-cron (15 workers)
- **Validation**: Zod
- **Logging**: Pino
- **Auth**: Bearer tokens (timing-safe comparison)

---

## Setup

```bash
cp .env.example .env
# Fill in your API keys
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

### Required env vars

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Supabase session pooler connection string |
| `EASYEARNS_API_KEY` | API key for Easyearns access |
| `ADMIN_API_KEY` | API key for admin endpoints |
| `SERPER_API_KEY` | Serper.dev search API (2500/mo free) |
| `BRAVE_API_KEY` | Brave Search API (2000/mo free) |
| `CORS_ORIGINS` | Comma-separated allowed origins |

---

## Deployment

- **Host**: Railway (minimum compute tier, nixpacks build)
- **Database**: Supabase (free tier, session pooler on port 5432)
- **Healthcheck**: cron-job.org pings `/api/v1/health` every 5 min (prevents cold starts)
- **CI**: GitHub Actions — typecheck, vitest, build

```bash
railway up
```

---

## Constraints

- £0/month API budget — all free tiers
- No headless browser (Railway RAM limits)
- UK market only
- Cloudflare-protected sites excluded (HotUKDeals, MSE)
- No LLM-based extraction (API costs)
- No paid proxies

---

## License

Internal — Easyearns.com
