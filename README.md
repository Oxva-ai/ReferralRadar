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

Referrals are scored 0-1 based on six weighted factors:

| Factor | Weight | What it measures |
|--------|--------|------------------|
| Freshness | 20% | How recently discovered (decays over 30 days) |
| Novelty | 15% | Fewer sources = more novel (undiscovered) |
| Value | 20% | Higher reward amounts score better |
| UK signal | 10% | Stronger UK signals = more relevant |
| Engagement | 20% | Click-through rate on displayed offers |
| Source rarity | 15% | Brand-search/URL-guesser = 1.0, Serper/Brave = 0.3 |

### Review workflow

Referrals are auto-assigned a review status based on confidence:

| Status | Meaning |
|--------|---------|
| `approved` | Confidence ≥ 0.4, auto-approved for EasyEarns |
| `pending` | Awaiting manual review |
| `needs_fix` | Confidence < 0.2, likely needs data cleanup |
| `rejected` | Manually rejected |

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
| `PATCH /admin/referrals/:id/review` | Set review status |
| `GET /admin/referrals/pending-review` | List referrals needing review |
| `POST /admin/referrals/auto-approve` | Bulk approve by confidence threshold |
| `GET /admin/workers/:name` | Worker run history |
| `POST /admin/workers/:name/restart` | Trigger worker immediately |
| `GET /admin/blocklist` | List blocked domains |
| `POST /admin/blocklist` | Add domain to blocklist |
| `DELETE /admin/blocklist/:domain` | Remove domain |
| `POST /admin/brands/reload` | Reload brand directory from DB |
| `GET /admin/webhooks` | List webhooks |
| `POST /admin/webhooks` | Register webhook |
| `DELETE /admin/webhooks/:id` | Remove webhook |
| `GET /admin/webhooks/:id/deliveries` | Webhook delivery history |
| `POST /admin/keys/rotate` | Rotate API key (7-day grace period) |
| `GET /admin/keys/status` | Key rotation status |

---

## Tech stack

- **Runtime**: Node.js 22+, TypeScript strict, ESM
- **Framework**: Express 5
- **Database**: Supabase PostgreSQL (pgcrypto, pg_trgm, fuzzystrmatch) — 16 tables, RLS enabled
- **HTTP**: `got` (HTTP/2, retry, circuit breaker)
- **Scraping**: Cheerio
- **Scheduling**: node-cron (13 workers)
- **Queue**: Postgres-backed durable queue (`FOR UPDATE SKIP LOCKED`)
- **Webhooks**: HMAC-SHA256 signed, exponential backoff retry (5 attempts)
- **Validation**: Zod
- **Logging**: Pino
- **Auth**: Bearer tokens (timing-safe comparison), key rotation with grace period
- **Testing**: Vitest 3.x — 52 unit tests + 9 DB integration tests

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

### Available scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run typecheck` | TypeScript type checking |
| `npm test` | Run 52 unit tests |
| `npm run test:integration` | Run 9 DB-backed integration tests (requires Postgres) |
| `npm run db:migrate` | Apply schema to database |
| `npm run db:seed` | Seed initial data |
| `npm run lint` | ESLint code quality |

### Required env vars

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Supabase session pooler connection string |
| `EASYEARNS_API_KEY` | API key for Easyearns access |
| `ADMIN_API_KEY` | API key for admin endpoints |
| `SERPER_API_KEY` | Serper.dev search API (2,500/mo free) |
| `BRAVE_API_KEY` | Brave Search API (2,000/mo free) |
| `LOGO_DEV_TOKEN` | Logo.dev API token for brand logos |
| `CORS_ORIGINS` | Comma-separated allowed origins |
| `EASYEARNS_STAGING_ORIGINS` | Comma-separated staging origins for CORS |
| `REFERRAL_RETENTION_DAYS` | Days before soft-deleting old referrals (default 365) |
| `EVENT_RETENTION_DAYS` | Days before removing old click/impression events (default 90) |
| `KEY_ROTATION_GRACE_DAYS` | Days old API key remains valid after rotation (default 7) |

---

## Deployment

- **Host**: Railway (minimum compute tier, nixpacks build)
- **Database**: Supabase (free tier, session pooler on port 5432)
- **Healthcheck**: cron-job.org pings `/api/v1/health` every 5 min (prevents cold starts)
- **CI**: GitHub Actions — Postgres 15 service → migrations → typecheck → 52 unit tests → 9 integration tests → build
- **DB pool**: Limited to 5 connections (Supabase free tier limit)

```bash
railway up
```

---

## Extraction fields

Each referral carries these extracted fields:

| Field | Type | Description |
|-------|------|-------------|
| `company_name` | string | Cleaned company name via brand DB or extraction |
| `brand` | string | Resolved brand from 208-UK-brand directory |
| `reward` | string | Raw reward text (e.g. "£20") |
| `reward_numeric` | number | Parsed numeric value |
| `reward_type` | enum | dual, per_referral, capped, free_product, free_share, switching_bonus, percentage, signup_credit, image_text |
| `referrer_reward` | string | What the referrer gets |
| `referee_reward` | string | What the friend gets |
| `offer_summary` | string | Human-readable summary (e.g. "You get £20, your friend gets £25") |
| `referral_link` | string | Shareable referral URL |
| `referral_code` | string | Extracted code from URL params or page text |
| `qualifying_spend` | string | Minimum spend/deposit required |
| `max_referrals` | number | Maximum referrals allowed |
| `terms_url` | string | Link to T&Cs page |
| `expires_at` | string | Detected offer expiry date (ISO 8601) |
| `confidence` | number | 0-1 quality score based on signal strength |
| `review_status` | enum | pending, approved, rejected, needs_fix |
| `category` | string | Resolved category from brand directory |
| `first_source` | string | Which discovery source found this first |
| `score` | number | 0-1 composite score |

---

## Constraints

- £0/month API budget — all free tiers
- No headless browser (Railway RAM limits)
- UK market only
- Cloudflare-protected sites excluded (HotUKDeals, MSE)
- No LLM-based extraction (API costs)
- No paid proxies

---

### Timezones

All timestamps are stored as `TIMESTAMPTZ` (UTC) in the database. API responses return ISO 8601 strings. Display in any timezone by converting client-side.

### Data retention

| Data | Retention |
|------|-----------|
| Referrals | 365 days then soft-deleted |
| Click/impression events | 90 days then removed |
| Worker logs, search queries, dead letters, webhook deliveries | 30 days |
| Pending submissions | 7 days |

Configure via `REFERRAL_RETENTION_DAYS` and `EVENT_RETENTION_DAYS` env vars.

---

## License

Internal — Easyearns.com
