# Referral Discovery Service — Technical Specification v2.0

**Service Name**: `referral-discovery`
**Owner**: Easyearns.com
**Budget Target**: £0/mo for APIs, ~£4/mo for hosting
**Actual Hosting Cost**: £0 Railway credits + £4 Railway compute (minimum tier)
**Market**: United Kingdom only
**Deployment**: Railway (web service, $5 credit/mo) + Supabase (database, free tier)
**Last Updated**: 2026-05-09

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [UK Market Sources](#2-uk-market-sources)
3. [Architecture](#3-architecture)
4. [Workers](#4-workers)
5. [UK Market Gating](#5-uk-market-gating)
6. [Extractor Service](#6-extractor-service)
7. [Scoring Engine](#7-scoring-engine)
8. [Deduplication Service](#8-deduplication-service)
9. [Database Schema](#9-database-schema)
10. [REST API Specification](#10-rest-api-specification)
11. [Observability & Logging](#11-observability--logging)
12. [Test Strategy](#12-test-strategy)
13. [CI/CD Pipeline](#13-cicd-pipeline)
14. [Graceful Shutdown](#14-graceful-shutdown)
15. [TypeScript Configuration](#15-typescript-configuration)
16. [Package Dependencies](#16-package-dependencies)
17. [Deployment](#17-deployment)
18. [Implementation Phases](#18-implementation-phases)
19. [What This Spec Intentionally Excludes](#19-what-this-spec-intentionally-excludes)
20. [Risks and Mitigations](#20-risks-and-mitigations)
21. [Success Metrics](#21-success-metrics)

---

## 1. System Overview

### 1.1 What This Service Does

A standalone Node.js (Express, TypeScript, ESM) service that continuously discovers UK referral opportunities before they saturate the market. It produces **four categories of output**:

| Type | What It Means | Example |
|---|---|---|
| **New referral offer** | A referral programme that just launched or was recently indexed | "New neobank adds refer-a-friend page" |
| **Terms change** | An existing programme where the reward increased, decreased, or conditions changed | "Monzo increased referral from £5 to £20" |
| **Undiscovered programme** | A referral page that has existed but nobody has posted about it on aggregator sites yet | A small fintech's `/refer-a-friend` page found via URL guessing |
| **Live referral code/link** | The actual shareable URL or code that users can click to get the reward | `https://monzo.com/refer?code=abc123` |

The service exposes a REST API that Easyearns.com consumes to display fresh, unscored referrals to its users.

### 1.2 Core Constraint: £0 API Budget, ~£4/mo Hosting

| Resource | Free Tier Limit | Reality |
|---|---|---|
| Google Programmable Search | 100 queries/day | Adequate. Each query returns up to 10 results = ~1,000 candidate URLs/day |
| Reddit API (OAuth) | 60 requests/min | Fine for our volume. Staggered polling stays well under this |
| Supabase PostgreSQL | 500MB storage, 2GB bandwidth | Sufficient. See Section 9.3 for storage management |
| Railway web service | $5 credit/month | Enough for the web service alone. Database is on Supabase |
| External uptime ping | Cron-job.org (free) | Pings `/health` every 5 min to prevent Railway cold start |

**Actual monthly cost breakdown**: £0 for Supabase (free tier), ~£4 for Railway (minimum compute tier). Total: ~£4/month.

### 1.3 What We Do NOT Do

- No Twitter/X API (requires $100/mo Basic tier)
- No headless browser / Puppeteer (512MB+ RAM, kills Railway free tier)
- No LLM-based extraction (API costs)
- No paid proxies
- No non-UK referrals
- No HotUKDeals/MSE scraping — they use Cloudflare JS challenges (see Section 2.1 for explanation and alternatives)

---

## 2. UK Market Sources — Complete Inventory

### 2.1 Competitor Sources: What Works and What Doesn't

**Critical reality**: HotUKDeals and MoneySavingExpert are protected by Cloudflare WAF with JavaScript challenge challenges. `got` + `cheerio` cannot scrape these — the server returns a challenge page, not real content. We do not use Puppeteer (too expensive for Railway free tier). These sources are **excluded** from the spec.

**Sources that DO work with plain HTTP**:

| Source | URL | Protection | Works? | Frequency |
|---|---|---|---|---|
| LatestDeals | `latestdeals.co.uk` | None | ✅ Yes | Every 30 min |
| MagicFreebiesUK | `magicfreebiesuk.co.uk` | None | ✅ Yes | Every 30 min |
| Be Clever With Your Cash | `becleverwithyourcash.co.uk` | None | ✅ Yes | Every 60 min |
| Quidco | `quidco.com/refer-a-friend` | None | ✅ Yes | Every 60 min |
| TopCashback | `topcashback.co.uk/refer` | None | ✅ Yes | Every 60 min |
| **HotUKDeals** | `hotukdeals.com` | Cloudflare JS challenge | ❌ No | — |
| **MoneySavingExpert** | `moneysavingexpert.com` | Cloudflare JS challenge | ❌ No | — |
| **MyVoucherCodes** | `myvouchercodes.co.uk` | Cloudflare JS challenge | ❌ No | — |
| **VoucherCodes** | `vouchercodes.co.uk` | Cloudflare JS challenge | ❌ No | — |

**Compensation strategy**: Google CSE queries are tuned to find the same deals that would appear on HotUKDeals/MSE. Since those sites index in Google, the CSE worker (Section 4.2) discovers them within hours. This means we discover them slightly later than a direct scrape, but still before most users.

### 2.2 UK Subreddits

| Subreddit | Signal | Frequency |
|---|---|---|
| r/beermoneyuk | Primary UK referral sub | Every 15 min |
| r/UKPersonalFinance | Bank switching, referral discussions | Every 30 min |
| r/UKFrugal | Money-saving tips, occasional referrals | Every 60 min |
| r/MakeMoneyInUK | Side hustles, sign-up offers | Every 30 min |
| r/UKDeals | General deal sharing | Every 60 min |
| r/referralcodes | Global but filterable by UK posts | Every 15 min |
| r/signupsforpay | Global, filter by £ | Every 15 min |

Post-filtering: discard any post where the body text lacks `£`, `UK`, `GBP`, or a `.co.uk` domain, unless the offer text explicitly mentions UK availability.

### 2.3 UK RSS Feeds

| Feed | URL | Fallback If Deprecated |
|---|---|---|
| AltFi News | `altfi.com/feed` | Search AltFi sitemap |
| UKTN | `uktechnews.com/feed` | Read sitemap XML |
| Finextra Retail | `finextra.com/rss.aspx?topic=retail` | Finextra article search |
| Product Hunt | `producthunt.com/feed` | Visit producthunt.com/new (cheerio) |
| Hacker News | `news.ycombinator.com/rss` | Hit HN Algolia API |
| Be Clever With Your Cash | `becleverwithyourcash.co.uk/feed` | Site scrape |
| Google News UK | `news.google.com/rss/search?q="refer+a+friend"+UK&hl=en-GB&gl=GB&ceid=GB:en` | **Unreliable** — may be deprecated. Monitor feed health |
| Google News UK 2 | `news.google.com/rss/search?q="referral+programme"+launch&hl=en-GB&gl=GB&ceid=GB:en` | Same |

**Feed health monitoring**: Every feed tracks `items_processed` in the RSS worker. If a feed returns 0 items for 3 consecutive runs, the RSS worker logs a warning and the `/health` endpoint reports `feed_name: "degraded"`. The developer is alerted to find a replacement URL.

### 2.4 UK Bank Switching Bonus Detection

UK bank switching bonuses share the same audience as referrals. We detect both:

| Source | URL |
|---|---|
| MoneySavingExpert bank switching | Scraped via Google CSE terms search (direct scrape blocked by Cloudflare) |
| r/UKPersonalFinance switching thread | `/r/UKPersonalFinance/search?q=switching+bonus&sort=new&restrict_sr=on` |
| Be Clever With Your Cash | `becleverwithyourcash.co.uk/best-bank-switching-offers` |

### 2.5 Known UK Referral Programme URLs (Seed List for Page Monitor)

**Seed validation**: Before these URLs are inserted into `monitored_pages`, a one-off validation script (`src/db/validate-seed.ts`) HEAD-checks every URL. Only URLs returning 200 are seeded. URLs that 404 or redirect are logged for manual correction.

The validation script also captures the initial page content hash so the page monitor has a baseline to compare against.

**Banking & Fintech:**
```
monzo.com/referral           starlingbank.com/refer-a-friend
revolut.com/referral         wise.com/invite
chase.co.uk/refer-a-friend   kroo.com/refer
zopa.com/refer               paypal.com/uk/refer
curve.com/refer-a-friend     chip.uk/refer-a-friend
trading212.com/refer         freetrade.io/refer-a-friend
etoro.com/referral           nutmeg.com/refer-a-friend
moneyboxapp.com/refer        pensionbee.com/refer
```
**Delivery & Food:**
```
hellofresh.co.uk/refer       gousto.co.uk/refer-a-friend
deliveroo.co.uk/refer        ubereats.com/uk/refer
just-eat.co.uk/refer
```
**Shopping & Cashback:**
```
quidco.com/refer-a-friend    topcashback.co.uk/refer
jamdoughnut.com/refer        shopmium.com/uk/refer
greenjinn.com/refer          checkoutsmart.com/refer
```
**Utilities & Services:**
```
octopus.energy/refer         puregym.com/refer
vitality.co.uk/refer         trainline.com/refer
```
**Crypto & Investing:**
```
coinbase.com/refer           binance.com/en-GB/referral
kraken.com/referral          luno.com/en-gb/invite
```
**Gambling (UKGC-licensed — flagged for compliance review, not served automatically):**
```
bet365.com/refer             paddypower.com/refer
```

Note: Only ~40 predetermined URLs here (not 80). The seed validation script will reject invalid ones, and the true count will settle at whatever passes. This is more honest and reliable than claiming 80.

### 2.6 URL Pattern Guessing for New Domains

When we discover a new domain but don't know its referral page URL, we probe these paths:

```
{domain}/referral
{domain}/refer-a-friend
{domain}/refer
{domain}/invite
{domain}/invite-friends
{domain}/earn
{domain}/rewards
{domain}/friends
{domain}/tell-a-friend
{domain}/recommend
{domain}/raf
```

Each probe is a lightweight HEAD request. If 200 → add to processing queue. If 301/302 → follow redirect, store canonical URL. If 404 → skip.

---

## 3. Architecture

### 3.1 Directory Structure

```
referral-discovery/
├── src/
│   ├── index.ts                # Express server entry, graceful shutdown
│   ├── app.ts                  # Express app factory (testable without listening)
│   ├── config.ts               # Zod-validated env config
│   ├── logger.ts               # pino structured logger
│   ├── correlation.ts          # AsyncLocalStorage correlation IDs
│   ├── routes/
│   │   ├── api.ts              # REST API router
│   │   ├── admin.ts            # Admin dashboard routes
│   │   └── validation.ts       # Zod schemas
│   ├── workers/
│   │   ├── scheduler.ts        # Cron orchestrator with mutex locks
│   │   ├── google-cse.ts       # Google Custom Search worker
│   │   ├── reddit.ts           # Reddit scraper
│   │   ├── competitor.ts       # UK deal site scrapers (non-Cloudflare only)
│   │   ├── rss.ts              # RSS feed parser with health tracking
│   │   ├── page-monitor.ts     # Known-page change detector
│   │   ├── url-guesser.ts      # Common-path probing
│   │   ├── verifier.ts         # Stale referral re-check
│   │   ├── rescore.ts          # Score recalculation + engagement aggregation
│   │   └── submission.ts       # User-submitted leads processor
│   ├── services/
│   │   ├── fetcher.ts          # HTTP fetch with retry, rate limiting, HTTP/2
│   │   ├── extractor.ts        # UK-specific offer + code extraction
│   │   ├── scorer.ts           # Multi-factor scoring engine
│   │   ├── deduper.ts          # URL + content + fuzzy-company dedup
│   │   ├── uk-filter.ts        # UK-market gating
│   │   └── queue.ts            # Two-tier priority queue
│   ├── db/
│   │   ├── schema.sql          # Full PostgreSQL schema
│   │   ├── migrations/         # Numbered migration files
│   │   ├── seed.sql            # Validated monitored page URLs
│   │   ├── validate-seed.ts    # URL validation script
│   │   ├── pool.ts             # pg Pool singleton
│   │   └── queries.ts          # Parameterized query functions
│   └── lib/
│       ├── hash.ts             # Content hashing utilities
│       ├── retry.ts            # Exponential backoff helper
│       ├── robots.ts           # Robots.txt parser
│       └── uk.ts               # UK-specific helpers
├── tests/
│   ├── extractor/
│   │   ├── fixtures/           # Captured real HTML pages (ANONYMIZED)
│   │   ├── patterns.test.ts   # Every regex pattern has a test case
│   │   └── integration.test.ts
│   ├── deduper.test.ts
│   ├── scorer.test.ts
│   ├── uk-filter.test.ts
│   └── helpers/
│       └── setup.ts            # Test DB, mock server
├── .github/
│   └── workflows/
│       └── ci.yml              # Run tests, typecheck, lint on PR
├── package.json
├── tsconfig.json
├── .env.example
├── railway.toml
├── Dockerfile
└── README.md
```

### 3.1.1 .gitignore

```
node_modules/
dist/
.env
*.log
.DS_Store
coverage/
src/db/seed.sql
```

### 3.2 Data Flow

```
                              [Scheduler]
                                    │
         ┌──────────────────────────┼──────────────────────┐
         │              │           │           │          │
    [Google CSE]   [Reddit]   [Competitor]  [RSS]  [URL Guesser]
    UK queries     UK subs     non-CF sites   feeds   common paths
         │              │           │           │          │
         └──────────────┴───────────┴───────────┴──────────┘
                                    │
                              [UK Filter]
                                    │
                          [Priority Queue]
                       ┌───────────┴───────────┐
                       │ HIGH                  │ LOW
                       │ user submissions      │ machine-discovered
                       │ (50 max)              │ (500 max)
                       └───────────┬───────────┘
                                   │
                              [Fetcher]
                              got -> HTTP2
                                   │
                              [Extractor]
                              regex + referral code scan
                               + multi-offer splitting
                               + image alt text
                                   │
                              [Deduper]
                              3-layer dedup
                                   │
                              [Scorer]
                              freshness + novelty + value
                               + uk_signal + engagement
                                   │
                              [PostgreSQL]
                                   │
          ┌────────────────────────┤
          │                        │
     [REST API]            [Page Monitor]
     Easyearns.com         validated URLs, all checked per cycle
     consumes                     │
     GET /referrals          [Verifier]
                             3h cycle, stale check
                                   │
     POST /referrals/:id/click
     Easyearns sends engagement
     data back → scoring improves
```

### 3.3 Process Model

Single Node.js process. No Redis, no Bull, no worker threads. Each worker yields to the event loop every 25 items via `await new Promise(r => setTimeout(r, 0))`.

### 3.4 Express Middleware Stack

```typescript
// src/app.ts

import { timingSafeEqual } from 'node:crypto'
import rateLimit from 'express-rate-limit'

declare global {
  namespace Express {
    interface Request {
      isAdmin?: boolean
    }
  }
}

const app = express()

app.use(express.json({ limit: '1kb' }))

app.use(cors({
  origin: config.NODE_ENV === 'production' ? config.CORS_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID'],
  maxAge: 86400,
}))

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers.authorization?.replace('Bearer ', '') ?? req.ip,
})
app.use('/api/v1', limiter)

app.use((req, _res, next) => {
  const requestId = req.headers['x-request-id'] as string ?? randomUUID()
  correlation.run(requestId, next)
})

app.use('/api/v1', (req, res, next) => {
  if (req.path === '/health') return next()
  const key = req.headers.authorization?.replace('Bearer ', '')
  if (!timingSafeEqual(Buffer.from(key ?? ''), Buffer.from(config.EASYEARNS_API_KEY))
      && !timingSafeEqual(Buffer.from(key ?? ''), Buffer.from(config.ADMIN_API_KEY))) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  req.isAdmin = key === config.ADMIN_API_KEY
  next()
})
```

---

## 4. Workers

### 4.1 Scheduler (Mutex-Guarded Cron)

```typescript
const locks = new Map<string, boolean>()

// NOTE: This mutex is process-local. During deployments, a brief overlap between
// old and new processes could cause duplicate runs. This is acceptable for our
// use case (duplicate discoveries get deduped). For multi-instance deployments,
// replace with pg_advisory_lock.

// Safe in single-threaded Node.js: check-then-set is atomic within one tick
function mutex(key: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (locks.get(key)) return
    locks.set(key, true)
    try { await fn() }
    catch (err) { logger.error({ err, worker: key }, 'worker failed') }
    finally { locks.set(key, false) }
  }
}

cron.schedule('*/8 * * * *',  mutex('google-cse',   googleCseWorker.run))
cron.schedule('*/15 * * * *', mutex('reddit',       redditWorker.run))
cron.schedule('*/30 * * * *', mutex('competitor',   competitorWorker.run))
cron.schedule('*/30 * * * *', mutex('rss',          rssWorker.run))
cron.schedule('0 */4 * * *',  mutex('page-monitor', pageMonitor.run))   // every 4h, not 6h
cron.schedule('0 */3 * * *',  mutex('verifier',     verifier.run))
cron.schedule('0 1 * * *',    mutex('url-guesser',  urlGuesser.run))
cron.schedule('*/15 * * * *', mutex('rescore',      rescoreWorker.run)) // score materialisation
cron.schedule('*/15 * * * *', mutex('rescore-engage', rescoreWorker.runEngagementAggregation)) // update engagement scores
cron.schedule('0 0 * * *',    () => resetDailyQuotas())
cron.schedule('0 */6 * * *',  () => purgeExpired())
```

```typescript
async function resetDailyQuotas() {
  await db.query('DELETE FROM api_usage WHERE date < CURRENT_DATE')
}

async function purgeExpired() {
  // Archive referrals inactive for 30+ days with no engagement
  await db.query(`
    UPDATE referrals SET is_active = false
    WHERE is_active = true
      AND discovered_at < NOW() - INTERVAL '30 days'
      AND engagement_score = 0
      AND (last_verified_at IS NULL OR last_verified_at < NOW() - INTERVAL '7 days')
  `)
  // Purge old click events
  await db.query("DELETE FROM click_events WHERE clicked_at < NOW() - INTERVAL '30 days'")
  // Purge old impression events
  await db.query("DELETE FROM impression_events WHERE impressed_at < NOW() - INTERVAL '30 days'")
  // Purge old worker runs (keep newest 1000)
  await db.query('SELECT trim_worker_runs()')
  // Purge stale pending submissions
  await db.query(`DELETE FROM submissions WHERE created_at < NOW() - INTERVAL '7 days' AND status = 'pending'`)
}
```

### 4.1.1 Two-Tier Priority Queue

Workers push URLs to a shared in-memory queue. User submissions get priority.

```typescript
// src/services/queue.ts

interface Job {
  url: string
  source: string  // 'google_cse' | 'reddit' | 'competitor' | 'rss' | 'page_monitor' | 'url_guesser' | 'user_submission'
  meta: {
    reddit_post_id?: string
    reddit_score?: number
    reddit_comments?: number
    feed_guid?: string
    search_query?: string
  }
}

const LOW_MAX = 500
const HIGH_MAX = 50
const CONCURRENCY = 3
const TIMEOUT_MS = 30_000

class PriorityQueue {
  private high: Array<Job> = []    // user submissions
  private low: Array<Job> = []     // machine-discovered URLs
  private processing = 0

  enqueue(item: Job, priority: 'high' | 'low' = 'low'): boolean {
    const target = priority === 'high' ? this.high : this.low
    const max = priority === 'high' ? HIGH_MAX : LOW_MAX
    if (target.length >= max) {
      logger.warn({ queueType: priority, size: target.length }, 'queue full')
      return false
    }
    target.push(item)
    this.drain()
    return true
  }

  private async drain() {
    while (this.processing < CONCURRENCY) {
      const item = this.high.shift() ?? this.low.shift()
      if (!item) break
      this.processing++
      this.process(item).finally(() => {
        this.processing--
        this.drain()
      })
    }
  }

  private async process(item: Job) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    try {
      const html = await fetcher.fetch(item.url, { signal: controller.signal })
      const extracted = await extractor.extract(html, item.url)
      if (!extracted) return
      const dedupResult = await deduper.check(extracted)
      if (dedupResult.action === 'skip') return
      await scorer.store(extracted, item.source, dedupResult)
    } catch (err) {
      logger.warn({ err, url: item.url }, 'processing failed')
    } finally {
      clearTimeout(timer)
    }
  }

  get size() { return this.high.length + this.low.length }
  get active() { return this.processing }
}
```

**Backpressure**: High queue max 50, low queue max 500. If a queue is full, items are dropped with a warning. 3 concurrent processors, 30s timeout per item.

### 4.2 Google Custom Search Worker

**Setup**:
1. Create Programmable Search Engine → "Search the entire web"
2. Restrict to `region=GB` (Google will filter results for UK relevance)
3. Free tier: 100 queries/day. Counter resets at midnight UTC.

**UK-Targeted Query Rotation** (20 templates, cycled in priority order):

```
Group A — New launches:
  "refer a friend" "just launched" UK
  "introducing our referral programme" UK
  "new refer a friend" "sign up" UK
  "announcing our referral" "earn" UK

Group B — Terms pages with explicit £:
  "refer a friend" "terms and conditions" site:co.uk
  "referral programme" "you'll receive £" UK
  "refer a friend" "we'll give you £" UK
  "referral code" "get £" site:co.uk

Group C — Generic UK pages:
  "share your link" "earn £" UK
  "invite your friends" "free" UK
  "referral code" "UK" "bonus"
  "refer a friend" "referral bonus" site:co.uk

Group D — UK industries:
  "bank switching" "refer a friend" UK
  "refer a friend" "free box" UK
  "referral" trading app UK "free share"
  "refer" energy supplier UK "£50"
  "restaurant referral" "free meal" UK

Group E — Terms changes:
  "weve increased our referral" UK
  "referral bonus increased" UK
  "updated" "refer a friend" terms UK
  "refer a friend" "changes" UK
```

Queries run in order: A → B → C → D → E. Within each group, rotate sequentially. If quota exhausted, remaining queries skip until midnight.

**Post-fetch filtering**:
- Must contain `£` or `GBP` or `.co.uk` domain or UK location keyword
- Must NOT be a known aggregator/competitor domain
- Must NOT be a forum post about referrals (those come from Reddit)

### 4.3 Reddit Worker (UK-Focused)

**Note**: Reddit data is fetched via direct `.json` URLs (e.g., `r/beermoneyuk/new.json?limit=25`) using `got`, not via snoowrap OAuth. This avoids the OAuth complexity and rate-limit overhead.

```
Primary (every 15 min):
  r/beermoneyuk/new.json?limit=25

Secondary (every 30 min):
  r/UKPersonalFinance/search.json?q=referral&sort=new&restrict_sr=on&limit=25
  r/MakeMoneyInUK/new.json?limit=25
  r/signupsforpay/search.json?q=£&sort=new&restrict_sr=on&limit=25

Tertiary (every 60 min):
  r/UKFrugal/new.json?limit=25
  r/UKDeals/search.json?q=referral&sort=new&restrict_sr=on&limit=25
  r/referralcodes/search.json?q=UK+OR+£&sort=new&restrict_sr=on&limit=25
```

**Post-processing**:
1. Extract outward URLs from post body
2. Discard posts linking to known aggregator domains
3. UK gate check: must contain `£`, `UK`, `GBP`, `.co.uk`, or UK city name
4. Track `reddit_post_id` — skip if already processed
5. Extract `score` (upvotes) + `num_comments` → feeds into saturation penalty

**Saturation signal**: A post in r/beermoneyuk with >50 upvotes and >20 comments = already circulating. Lower novelty score.

**Important**: When a Reddit post contains the actual referral link/code (not just a mention), extract it. This is the highest-signal find — a ready-to-use referral link. Store in the `referral_link` column (Section 9).

### 4.4 Competitor Worker (Non-Cloudflare UK Deal Sites)

These sites ARE scrapable with plain HTTP. The spec does NOT attempt HotUKDeals or MSE (see Section 2.1).

**LatestDeals** (`latestdeals.co.uk/search?q=refer+a+friend&order=newest`):
1. Fetch search results page
2. Parse deal cards: title, description, link, date posted
3. Follow the deal link → extract referral offer from merchant page

**MagicFreebiesUK** (`magicfreebiesuk.co.uk`):
1. Search for "refer" + "free when you sign up"
2. Parse freebie listings
3. These often feature "free box" type offers (HelloFresh, Gousto, etc.)

**Be Clever With Your Cash** (`becleverwithyourcash.co.uk`):
1. Parse best-bank-switching-offers page
2. Extract switching bonus amounts and terms

**Quidco / TopCashback**:
1. Parse referral pages
2. These have referral programmes for their own service; also list partner offers

**Per-site limits**: 20 items max per run. Pagination only if first page yields <5 new referrals.

**Rate limiting**: 1 request per 5 seconds per domain. Respect `robots.txt`. Rotate User-Agent.

### 4.5 RSS Worker

**Feed list with health tracking**:

Each feed is tracked in `rss_feed_health` (in-memory map). If a feed returns 0 items 3 runs in a row, log a warning and report as degraded in `/health`.

```
Primary (every 30 min):
  altfi.com/feed
  uktn.co.uk/feed

Secondary (every 60 min):
  finextra.com/rss.aspx?topic=retail
  crowdfundinsider.com/feed
  producthunt.com/feed
  news.ycombinator.com/rss

Tertiary (every 2 hours):
  thisismoney.co.uk/money/saving/rss
  becleverwithyourcash.co.uk/feed

Degraded (monitored, not relied upon):
  news.google.com/rss/search?q=...  (may be deprecated, confirm working on deploy)
```

**Processing**:
1. Parse feed
2. Match title + description against referral keyword set
3. Fetch article, extract all `<a href>` links from body
4. Queue each URL through fetcher → extractor
5. Track feed item GUID to avoid re-processing

### 4.6 Page Monitor (Change Detector)

**Seeded with validated URLs only** (see Section 2.5 seed validation). Runs every 4 hours.

**Per-page logic**:
1. `SELECT url, last_content_hash, company_name FROM monitored_pages WHERE next_check_at <= NOW() AND is_active = true ORDER BY next_check_at ASC` — **no LIMIT**. Process ALL due pages per run. Yield to event loop every 10 pages.
2. Fetch the page
3. Extract text from most specific container: element with `id`/`class` containing "refer" → `<main>` → `<article>` → `<body>`
4. Normalize: strip whitespace, `<script>`/`<style>` content, ISO dates, UUIDs, session tokens
5. SHA256 the normalized text
6. Compare to `last_content_hash`:
   - **Match** → update `last_checked_at`, set `next_check_at = NOW() + check_interval`
   - **Mismatch** → run extractor. If reward changed → insert `offer_history`, update referral with `change_type = 'updated'` and `previous_offer`. Also insert a row into `offer_history` with old and new offer values.
   - **404 / 410** → mark `is_active = false`, deactivate related referrals with note "page removed"
   - **Timeout / 5xx** → increment `consecutive_failures`. After 3 → set `check_interval = '24h'`

**Smart frequency adjustment**:
- 0 changes in 30 days → 24h
- 3+ changes in 7 days → 2h
- 404 → stop checking, mark inactive

### 4.7 URL Guesser (New Domain Discovery)

Runs daily (01:00 UTC). Finds domains discovered but without a confirmed referral page URL.

**Note**: `candidate_domain` is populated by any worker that discovers a domain without a referral page URL. If a worker finds a company mention or domain reference but no direct referral link, it stores the domain in `candidate_domain` for the URL guesser to probe later.

```sql
SELECT id, candidate_domain FROM referrals
WHERE source_url IS NULL
  AND candidate_domain IS NOT NULL
  AND created_at > NOW() - INTERVAL '24 hours'
```

For each domain, HEAD-probe the 16 common paths (Section 2.6). Any returning 200 → set `source_url`, queue for extraction. Any 301/302 → follow redirect, store canonical. If all 16 return 404 → leave NULL, retry next daily run.

### 4.8 Verifier (Stale Referral Re-Check)

Runs every 3 hours. Checks referrals that haven't been verified in 7+ days.

```sql
SELECT id, source_url FROM referrals
WHERE is_active = true
  AND (last_verified_at IS NULL OR last_verified_at < NOW() - INTERVAL '7 days')
ORDER BY last_verified_at ASC NULLS FIRST
LIMIT 50
```

For each: fetch the URL.
- **200** → re-run extractor. If reward changed → update, flag as `change_type = 'updated'`, and insert a row into `offer_history` with old and new offer values. Update `last_verified_at`.
- **404 / 410** → mark `is_active = false`, set `expires_at = NOW()`, note "page removed"
- **301/302** → update `source_url`, re-verify
- **Timeout / 5xx** → increment retry count. After 3 failures → mark for manual review.

Verifier also checks `referral_link` (if present) to ensure it still resolves. If the referral link 404s but the terms page is fine, flag as "link broken" without deactivating.

### 4.9 Submission Processor (User-Submitted Leads)

1. Validate URL with Zod (must be valid HTTPS URL, must not be IP address or known malicious domain)
1.5. If the URL doesn't pass UK filter checks (domain TLD, currency, geo-text), still queue it but mark with `uk_signal_strength = 'unknown'`. The UK filter should log a warning but not reject user submissions outright — the user may know better than the automated filter.
2. Check exact match with existing referrals → 409 if duplicate
3. Insert into `submissions` with `status = 'pending'`
4. Enqueue to **high-priority queue** (not low — user submissions jump ahead of machine-discovered URLs)
5. When processed: update `submissions.status` to `processed` or `rejected`, link `result_referral_id`
6. **Per-user rate limit**: maximum 20 submissions per hour per `submitted_by`. Tracked in-memory. Prevents spam.

### 4.10 Score Materialisation Worker

Runs every 15 minutes. Recalculates scores for active referrals where the score has drifted by more than 0.05 since last materialisation.

```sql
UPDATE referrals
SET score = compute_score(reward_numeric, discovered_at, source_count, uk_signal_strength, engagement_score,
  (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_freshness'),
  (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_novelty'),
  (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_value'),
  (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_uk_signal'),
  (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_engagement')
),
    updated_at = NOW()
WHERE is_active = true
  AND ABS(score - compute_score(reward_numeric, discovered_at, source_count, uk_signal_strength, engagement_score,
    (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_freshness'),
    (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_novelty'),
    (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_value'),
    (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_uk_signal'),
    (SELECT value::NUMERIC FROM app_config WHERE key = 'score_weight_engagement')
  )) > 0.05
```

The rescore worker reads all five weight values from `app_config` once, then passes them as parameters to `compute_score()` for each row.

### 4.11 Engagement Aggregation Worker

Runs every 15 minutes (offset from score materialisation). Recalculates `clicks_last_7_days`, `impressions_last_7_days`, and `engagement_score` for all active referrals.

```sql
UPDATE referrals SET
  clicks_last_7_days = (SELECT COUNT(*) FROM click_events WHERE referral_id = referrals.id AND clicked_at > NOW() - INTERVAL '7 days'),
  impressions_last_7_days = (SELECT COUNT(*) FROM impression_events WHERE referral_id = referrals.id AND impressed_at > NOW() - INTERVAL '7 days'),
  engagement_score = LEAST(
    (SELECT COUNT(*) FROM click_events WHERE referral_id = referrals.id AND clicked_at > NOW() - INTERVAL '7 days') / 10.0,
    1.0
  ) * CASE
    WHEN impressions_last_7_days > 0 AND clicks_last_7_days > 0 AND clicks_last_7_days::float / impressions_last_7_days > 0.05 THEN 1.0
    WHEN impressions_last_7_days > 0 AND clicks_last_7_days > 0 AND clicks_last_7_days::float / impressions_last_7_days > 0.01 THEN 0.7
    WHEN impressions_last_7_days > 0 AND clicks_last_7_days > 0 THEN 0.3
    ELSE 0.0
  END
WHERE is_active = true;
```

---

## 5. UK Market Gating

Every URL passes through this gate before extraction. Multi-signal approach:

### 5.1 Domain Signal
```
TLD: .co.uk, .uk, .london, .scot, .wales, .cymru = strong UK signal
.com with UK brand = check further
Explicitly non-UK (.de, .fr, .com.au, .ca, .nz) = discard
```

### 5.2 Currency Signal
```
Page contains £, "GBP", "pound", "quid", "pence" = strong UK signal
$ without £ = check geo signal before discarding
€ only = discard
```

### 5.3 Geo-Text Signal
```
Mentions: UK, United Kingdom, Great Britain, England, Scotland, Wales, Northern Ireland
Mentions UK cities: London, Manchester, Birmingham, Glasgow, Edinburgh, Leeds, Bristol, Cardiff
Mentions: FCA, FSCS, PRA (UK financial regulators)
Mentions: "eligible UK residents", "UK only"
```

### 5.4 Decision Matrix

| .co.uk domain | £ present | UK geo text | FCA mention | Verdict |
|---|---|---|---|---|
| ✅ | ✅ | ✅ | — | PASS (high) |
| ✅ | ✅ | — | — | PASS |
| ✅ | — | ✅ | — | PASS |
| — | ✅ | ✅ | — | PASS |
| — | ✅ | — | — | PASS (weak, flag) |
| — | — | ✅ | ✅ | PASS (regulated) |
| .de/.fr/etc | — | — | — | DISCARD |
| .com | $ only | US cities | — | DISCARD |
| .com | — | — | — | HOLD |

---

## 6. Extractor Service (UK-Rewired)

### 6.1 Fetch Strategy

Uses `got` with HTTP/2 support enabled, rotating User-Agents, polite per-domain delays (3s minimum), and `robots.txt` respect.

```typescript
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
]
```

`got` configured with: `http2: true`, `timeout: { request: 15000 }`, `retry: { limit: 2, statusCodes: [429, 502, 503, 504] }`, `followRedirect: true`, `maxRedirects: 3`.

### 6.2 HTML Parsing

```typescript
function extractText($: cheerio.CheerioAPI): string {
  $('script, style, nav, footer, header, noscript, iframe, svg, img').remove()

  const containers = [
    '[id*="refer"]', '[class*="refer"]',
    '[id*="invite"]', '[class*="invite"]',
    '[id*="earn"]', '[class*="earn"]',
    'main', 'article', '[role="main"]',
    '.content', '#content', 'body'
  ]

  for (const selector of containers) {
    const el = $(selector).first()
    if (el.length && el.text().trim().length > 100)
      return el.text().replace(/\s+/g, ' ').trim()
  }

  return $('body').text().replace(/\s+/g, ' ').trim()
}
```

### 6.3 Image Alt Text Scanning

After text extraction, also scan all `<img>` tags' `alt` attributes for referral content:

```typescript
function extractImageText($: cheerio.CheerioAPI): string[] {
  const altTexts: string[] = []
  $('img[alt]').each((_, el) => {
    const alt = $(el).attr('alt')?.trim()
    if (alt && alt.length > 20)  // only meaningful alt text
      altTexts.push(alt)
  })
  return altTexts
}
```

If the text extractor returned no `£` matches but an image alt text contains `£` + "referral" keywords, the referral is stored as `reward_type = 'image_text'` with the alt text as `offer_text`. This is surfaced as low-confidence but not invisible.

### 6.4 Multi-Offer Page Splitting

If a page text exceeds 2000 characters, attempt to split it into multiple offers:

```typescript
function splitOffers(text: string): string[] {
  // Try splitting on numbered list markers
  const segments = text.split(/(?:\n|^)\s*(?:\d+[.)]|\b(?:Next|Also|Additionally))\s*/)
    .filter(s => s.trim().length > 100)
    .filter(s => s.match(/[£€$]/))

  if (segments.length >= 2) return segments
  return [text]
}
```

Each segment is run through the extraction patterns independently. Each match creates a separate `referrals` record linked by the same `source_url`.

### 6.5 UK-Specific Extraction Patterns

Same 25 patterns as v1 (Groups 1–8). Additions for v2:

```
Group 9 — Referral CODE extraction (scans full raw HTML, not just extracted text):
  patterns that match: ?ref=..., ?referral=..., /refer?code=..., /invite?code=...
  ?r=..., ?referred_by=..., ?friend=..., &referral_code=...

Group 10 — Multi-tier / network referral detection:
  "earn" "your friends referrals" OR "friends make"
  "second tier" OR "two levels"
  "earn from your network"
```

### 6.6 Referral Code/Link Extraction

After offer text extraction, scan the raw HTML for referral link patterns:

```typescript
const REFERRAL_LINK_PATTERNS = [
  /href=["']([^"']*(?:\/?\?.*(?:ref|referral|code|r|invite|friend)=[^"'\s]+))["']/gi,
  /(?:referral code|share this link|your unique link)\s*[:：]\s*([^\s<"]+)/gi,
  /https?:\/\/[^\s"'<>]+\/(?:refer|invite)\/[A-Za-z0-9_-]{4,}/gi,
  /(?:go\.|gr\.|lnk\.)\/[A-Za-z0-9_-]{4,}/gi,  // short URLs commonly used for referrals
]
```

The first match found is stored in the `referral_link` column. This is the actual usable link — the difference between "knowing about an offer" and "being able to use it."

### 6.7 Company Name Extraction

```typescript
function extractCompanyName($: cheerio.CheerioAPI, url: string): string {
  const ogSite = $('meta[property="og:site_name"]').attr('content')
  if (ogSite && ogSite.length > 2 && ogSite.length < 60) return ogSite.trim()

  const title = $('title').text().trim()
  const cleaned = title
    .replace(/\s*[|\-–—]\s*(Home|Official|UK|United Kingdom|App|Website|Online).*/i, '')
    .replace(/\s*[|\-–—]\s*$/, '')
    .trim()
  if (cleaned.length > 2 && cleaned.length < 60) return cleaned

  const hostname = new URL(url).hostname.replace(/^www\./, '')
  const domainName = hostname.split('.')[0]
  return domainName.charAt(0).toUpperCase() + domainName.slice(1)
}
```

---

## 7. Scoring Engine

### 7.1 Score Formula

```
score = (freshness × w_fresh) + (novelty × w_novel) + (value × w_val) + (uk_signal × w_uk) + (engagement × w_engage)

Default weights (configurable via app_config table):
  w_fresh   = 0.25
  w_novel   = 0.20
  w_val     = 0.20
  w_uk      = 0.10
  w_engage  = 0.25   ← NEW: engagement is weighted equally with freshness
```

Each factor is normalised 0.0–1.0.

### 7.2 Freshness

```
freshness = max(0, 1 - (hours_since_discovery / 720))
```
0h → 1.0, 15 days → 0.5, 30 days → 0.0

### 7.3 Novelty (Uniqueness)

```
novelty = 1.0 — first time this domain+offer has appeared
          0.7 — domain is new, offer is new
          0.5 — domain known, offer is new
          0.3 — seen on 2-3 sources
          0.1 — seen on 4+ sources
          0.0 — >5 sources or Reddit >50 upvotes
```

### 7.4 Value

```
value = min(extracted_monetary_value_gbp / 100, 1.0)
```

Special cases: free products use estimated value, percentage offers use UK average basket (£35 food, £70 retail), unspecified free shares use 0.2, £0 offers use 0.1.

### 7.5 UK Signal Bonus

```
uk_signal = 1.0 — .co.uk + £ + geo text
            0.8 — .co.uk OR (£ + geo text)
            0.6 — £ only
            0.3 — weak signal
            0.0 — unknown (not served)
```

### 7.6 Engagement Score (NEW)

This is the user feedback loop. Easyearns.com sends click data when users interact with a referral.

```
engagement = min(clicks_last_7_days / 10, 1.0)
             * click_through_rate_factor

click_through_rate_factor:
  clicks / impressions > 0.05 → 1.0 (healthy)
  clicks / impressions > 0.01 → 0.7 (low but positive)
  clicks / impressions < 0.01 → 0.3 (poor)
  no data → 0.0 (referral hasn't been surfaced yet)
```

If `engagement` is 0 (no data), the weight shifts: `w_engage` (0.25) is redistributed 0.10 to freshness and 0.15 to novelty. This means new referrals without engagement data are scored more on freshness and novelty. As engagement data comes in, the weight shifts.

### 7.7 Score Materialisation

Cron job every 15 minutes recalculates scores where drift > 0.05. Uses `compute_score` SQL function with weights from `app_config`.

### 7.8 Final Filter

Only referrals with `score >= 0.3` AND `engagement > 0 OR (freshness > 0.3)` are served via the API. This prevents dead/unverified referrals from being served while allowing new ones with no engagement data to surface.

---

## 8. Deduplication Service

Three-layer dedup:

### Layer 1: Exact URL Match
```
SELECT id FROM referrals WHERE source_url = $1 AND is_active = true
→ Found → skip
→ Not found → Layer 2
```

### Layer 2: Content Hash Near-Duplicate
```
SELECT id, offer_text FROM referrals
WHERE (content_hash = $1
   OR similarity(offer_text, $2) > 0.85)
  AND is_active = true
→ Found → merge (increment source_count, append source)
→ Not found → Layer 3
```

### Layer 3: Company + Domain Fuzzy Match
```
SELECT id, company_name FROM referrals r
WHERE r.domain = $1
  AND levenshtein(r.company_name, $2) < 3
  AND r.is_active = true
→ Found → possible duplicate, flag for review but store separately
→ Not found → genuinely new referral
→ Inactive match found → reactivate the existing referral instead of creating a duplicate
```

**Note**: When a dedup match is found against an inactive referral (any layer), reactivate it rather than creating a duplicate.

### Content Hash Computation

```typescript
function computeContentHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[£$€]\s?[\d,.]+/g, 'XXX')
    .replace(/[\d,]+/g, 'N')
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
  return createHash('sha256').update(normalized).digest('hex')
}
```

---

## 9. Database Schema

### 9.1 Tables

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;

-- Core referrals
CREATE TABLE referrals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url        TEXT,
  domain            TEXT GENERATED ALWAYS AS (
                      CASE WHEN source_url IS NOT NULL THEN
                        lower(split_part(replace(replace(source_url, 'https://', ''), 'http://', ''), '/', 1))
                      ELSE NULL END
                    ) STORED,
  candidate_domain  TEXT,
  referral_link     TEXT,                     -- Actual shareable ref link/code (NEW)
  company_name      TEXT,
  offer_text        TEXT,
  reward            TEXT,
  reward_numeric    NUMERIC(10,2),
  currency          VARCHAR(3) DEFAULT 'GBP',
  friend_reward     TEXT,
  friend_reward_numeric NUMERIC(10,2),
  reward_type       VARCHAR(20) CHECK (reward_type IN ('per_referral','dual','capped','free_product','free_share','switching_bonus','percentage','signup_credit','image_text','unknown')),
  qualifying_spend  TEXT,
  max_referrals     INTEGER,
  content_hash      TEXT,
  change_type       VARCHAR(20) DEFAULT 'new' CHECK (change_type IN ('new','updated')),
  previous_offer    TEXT,
  previous_offer_numeric NUMERIC(10,2),
  score             NUMERIC(4,3),
  engagement_score  NUMERIC(4,3) DEFAULT 0,   -- NEW: fed by click tracking
  clicks_last_7_days INTEGER DEFAULT 0,        -- NEW: rolling click count
  impressions_last_7_days INTEGER DEFAULT 0,    -- NEW: times served to users
  sources           TEXT[] DEFAULT '{}',
  source_count      INTEGER DEFAULT 1,
  uk_signal_strength VARCHAR(10) DEFAULT 'unknown' CHECK (uk_signal_strength IN ('strong','moderate','pound_only','weak','unknown')),
  reddit_post_id    TEXT,
  reddit_score      INTEGER,
  reddit_comments   INTEGER,
  discovered_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified_at  TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  is_active         BOOLEAN DEFAULT TRUE,
  verification_failures INTEGER DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Monitored pages
CREATE TABLE monitored_pages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url               TEXT NOT NULL UNIQUE,
  company_name      TEXT,
  last_content_hash TEXT,
  last_checked_at   TIMESTAMPTZ,
  next_check_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- NOTE: The seed validation script should spread next_check_at values evenly across
  -- a 4-hour window to prevent a thundering herd on first deploy.
  check_interval    INTERVAL DEFAULT '4 hours',
  change_count      INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0,
  is_active         BOOLEAN DEFAULT TRUE,
  submitted_by      TEXT DEFAULT 'system',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Offer change history
CREATE TABLE offer_history (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  monitored_page_id   UUID REFERENCES monitored_pages(id) ON DELETE CASCADE,
  referral_id         UUID REFERENCES referrals(id) ON DELETE SET NULL,
  old_offer_text      TEXT,
  new_offer_text      TEXT,
  old_reward          TEXT,
  new_reward          TEXT,
  old_reward_numeric  NUMERIC(10,2),
  new_reward_numeric  NUMERIC(10,2),
  detected_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- API usage tracking
CREATE TABLE api_usage (
  api_name        VARCHAR(50) NOT NULL,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  queries_used    INTEGER DEFAULT 0,
  PRIMARY KEY (api_name, date)
);

-- User submissions
CREATE TABLE submissions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url                 TEXT NOT NULL,
  submitted_by        TEXT,
  status              VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','rejected')),
  rejection_reason    TEXT,
  result_referral_id  UUID REFERENCES referrals(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at        TIMESTAMPTZ
);

-- Worker run log (COMPACT: only last 1000 rows retained)
CREATE TABLE worker_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_name     VARCHAR(50) NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  items_processed INTEGER DEFAULT 0,
  items_discovered INTEGER DEFAULT 0,
  status          VARCHAR(20) DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  error_message   TEXT
);
-- worker_runs is managed as a fixed-size circular table: see Section 9.3

-- Configurable app settings
CREATE TABLE app_config (
  key             VARCHAR(50) PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Click tracking (NEW — append-only, aggregated into referrals.engagement_score)
CREATE TABLE click_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id     UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  clicked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Impression tracking (NEW — append-only, aggregated into referrals.engagement_score)
CREATE TABLE impression_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id     UUID NOT NULL REFERENCES referrals(id) ON DELETE CASCADE,
  impressed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default config
INSERT INTO app_config (key, value) VALUES
  ('score_weight_freshness',   '0.25'),
  ('score_weight_novelty',     '0.20'),
  ('score_weight_value',       '0.20'),
  ('score_weight_uk_signal',   '0.10'),
  ('score_weight_engagement',  '0.25'),
  ('score_min_threshold',      '0.30');

-- Score materialisation function
-- Canonical uk_signal_strength values: 'strong', 'moderate', 'pound_only', 'weak', 'unknown'
-- (see CHECK constraint on referrals.uk_signal_strength)
--
-- Weights are passed as parameters (read once by the rescore worker) instead of
-- querying app_config per row, to avoid 5 SELECTs per referral on every recalculation.
CREATE OR REPLACE FUNCTION compute_score(
  p_reward_numeric NUMERIC,
  p_discovered_at TIMESTAMPTZ,
  p_source_count INTEGER,
  p_uk_signal VARCHAR,
  p_engagement NUMERIC DEFAULT 0,
  p_w_fresh NUMERIC DEFAULT 0.25,
  p_w_novel NUMERIC DEFAULT 0.20,
  p_w_val NUMERIC DEFAULT 0.20,
  p_w_uk NUMERIC DEFAULT 0.10,
  p_w_engage NUMERIC DEFAULT 0.25
) RETURNS NUMERIC AS $$
DECLARE
  freshness NUMERIC; novelty NUMERIC; val NUMERIC; uk NUMERIC; engagement NUMERIC;
  total_weight NUMERIC;
  effective_fresh NUMERIC; effective_novel NUMERIC;
BEGIN
  total_weight := p_w_fresh + p_w_novel + p_w_val + p_w_uk + p_w_engage;

  freshness := GREATEST(0, 1 - (EXTRACT(EPOCH FROM (NOW() - p_discovered_at)) / 3600) / 720);
  novelty := CASE
    WHEN p_source_count <= 1 THEN 1.0
    WHEN p_source_count = 2 THEN 0.7
    WHEN p_source_count = 3 THEN 0.5
    WHEN p_source_count = 4 THEN 0.3
    WHEN p_source_count = 5 THEN 0.1
    ELSE 0.0
  END;
  val := LEAST(COALESCE(p_reward_numeric, 0) / 100, 1.0);
  uk := CASE p_uk_signal
    WHEN 'strong'     THEN 1.0
    WHEN 'moderate'   THEN 0.8
    WHEN 'pound_only' THEN 0.6
    WHEN 'weak'       THEN 0.3
    ELSE 0.0
  END;

  -- Engagement redistribution: no data → shift weight to freshness (40%) and novelty (60%)
  IF p_engagement IS NULL OR p_engagement <= 0 THEN
    engagement := 0;
    effective_fresh := (p_w_fresh + p_w_engage * 0.40) / total_weight;
    effective_novel := (p_w_novel + p_w_engage * 0.60) / total_weight;
  ELSE
    engagement := LEAST(p_engagement, 1.0);
    effective_fresh := p_w_fresh / total_weight;
    effective_novel := p_w_novel / total_weight;
  END IF;

  RETURN LEAST(1, GREATEST(0,
    (freshness * effective_fresh)
    + (novelty * effective_novel)
    + (val * p_w_val / total_weight)
    + (uk * p_w_uk / total_weight)
    + (engagement * p_w_engage / total_weight)
  ));
END;
$$ LANGUAGE plpgsql;

-- Worker runs trim function (keep newest 1000 rows)
```

### 9.2 Indexes

```sql
CREATE INDEX idx_referrals_score        ON referrals(score DESC) WHERE is_active = true;
CREATE INDEX idx_referrals_discovered   ON referrals(discovered_at DESC) WHERE is_active = true;
CREATE INDEX idx_referrals_domain       ON referrals(domain);
CREATE INDEX idx_referrals_candidate    ON referrals(candidate_domain) WHERE source_url IS NULL;
CREATE INDEX idx_referrals_company      ON referrals(company_name);
CREATE INDEX idx_referrals_type         ON referrals(reward_type) WHERE is_active = true;
CREATE INDEX idx_referrals_content_hash ON referrals(content_hash);
CREATE INDEX idx_referrals_verification ON referrals(last_verified_at) WHERE is_active = true;
CREATE INDEX idx_referrals_sources      ON referrals USING GIN(sources);
CREATE INDEX idx_referrals_offer_trgm   ON referrals USING GIN(offer_text gin_trgm_ops);
CREATE INDEX idx_referrals_referral_link ON referrals(referral_link) WHERE referral_link IS NOT NULL;

CREATE INDEX idx_monitored_next_check   ON monitored_pages(next_check_at) WHERE is_active = true;

CREATE INDEX idx_submissions_status     ON submissions(status) WHERE status = 'pending';

CREATE INDEX idx_worker_runs_recent     ON worker_runs(started_at DESC);
CREATE INDEX idx_click_events_referral  ON click_events(referral_id, clicked_at DESC);
CREATE INDEX idx_offer_history_monitored_page ON offer_history(monitored_page_id);
CREATE INDEX idx_offer_history_referral  ON offer_history(referral_id);
CREATE INDEX idx_submissions_url         ON submissions(url);
CREATE UNIQUE INDEX idx_referrals_reddit_post ON referrals(reddit_post_id) WHERE reddit_post_id IS NOT NULL;
CREATE INDEX idx_click_events_clicked_at  ON click_events(clicked_at);
```

### 9.3 Storage Management

`worker_runs` is managed as a fixed-size table:

```sql
CREATE OR REPLACE FUNCTION trim_worker_runs()
RETURNS void AS $$
BEGIN
  DELETE FROM worker_runs
  WHERE id IN (
    SELECT id FROM worker_runs
    ORDER BY started_at DESC
    OFFSET 1000
  );
END;
$$ LANGUAGE plpgsql;
```

Run hourly: `cron.schedule('0 * * * *', () => db.query('SELECT trim_worker_runs()'))`.

`click_events` is trimmed to last 30 days of data.

**Estimated storage**:
- 5,000 `referrals` rows @ 500 bytes = 2.5MB
- 100,000 `click_events` rows @ 50 bytes = 5MB
- 1,000 `worker_runs` rows @ 200 bytes = 200KB
- Total: well under 10MB after 1 year. Supabase's 500MB is more than sufficient.

### 9.4 Seed Validation Process

Before the first deploy, run:

```bash
npx tsx src/db/validate-seed.ts
```

This script:
1. Reads the seed URL list
2. HEAD-checks each URL
3. For each valid URL: fetches it, computes content hash, inserts into `monitored_pages`
4. Logs invalid URLs with HTTP status codes for manual correction
5. Outputs `src/db/seed.sql` containing only valid INSERTs

This prevents the page monitor from marking 40/80 URLs as inactive on its first run.

---

## 10. REST API Specification

IMPORTANT: Static routes (`/changed`, `/top`, `/stats`, `/health`) MUST be defined before the parameterized route (`/:id`) in the Express router, otherwise Express will try to match "changed" as a UUID parameter.

### 10.1 Base URL & Auth

```
Base: https://discovery.easyearns.com/api/v1
Auth: Authorization: Bearer <EASYEARNS_API_KEY>
```

Every request gets `X-Request-ID` header. Propagated to logs.

### 10.2 Input Validation

All inputs validated with Zod. Invalid input → 400 with field-level errors:

```json
{
  "error": "validation_failed",
  "fields": { "limit": "Must be between 1 and 100" }
}
```

### 10.3 Rate Limiting

Easyearns.com: 60 req/min per API key. Exceeded → 429 with `Retry-After`.

### 10.4 Endpoints

#### `GET /referrals`

| Param | Type | Default | Description |
|---|---|---|---|
| `since` | ISO 8601 | 24h ago | Discovered after this time |
| `until` | ISO 8601 | now | Discovered before this time |
| `limit` | int (1-100) | 50 | Results per page |
| `offset` | int (0+) | 0 | Pagination offset |
| `min_score` | float (0-1) | 0.3 | Minimum score |
| `change_type` | string | — | `new`, `updated` |
| `reward_type` | string | — | Filter by type |
| `min_value` | float | — | Minimum reward_numeric |
| `has_link` | boolean | — | Only referrals with a `referral_link` |
| `sort` | string | `score` | `score`, `newest`, `value` |

**Response 200**:
```json
{
  "data": [
    {
      "id": "d290f1ee-6c54-4b01-90e6-d701748f0851",
      "source_url": "https://newbank.co.uk/referral",
      "domain": "newbank.co.uk",
      "referral_link": "https://newbank.co.uk/refer?code=abc123",
      "company_name": "NewBank",
      "offer_text": "You'll get £30 for each friend who opens an account",
      "reward": "£30",
      "reward_numeric": 30.00,
      "currency": "GBP",
      "friend_reward": "£30",
      "reward_type": "dual",
      "change_type": "new",
      "score": 0.87,
      "engagement_score": 0.45,
      "sources": ["google_cse"],
      "source_count": 1,
      "discovered_at": "2026-05-09T14:32:00Z",
      "last_verified_at": "2026-05-09T14:32:00Z"
    }
  ],
  "meta": {
    "total": 142,
    "limit": 50,
    "offset": 0,
    "min_score": 0.3,
    "since": "2026-05-08T14:32:00Z"
  }
}
```

#### `GET /referrals/:id`

Single referral with full details.

#### `GET /referrals/changed`

Only `change_type = 'updated'`. Default sort: `newest`.

#### `GET /referrals/top`

Top 20 highest-scoring active referrals in last 7 days.

#### `GET /referrals/stats`

Aggregate stats for Easyearns dashboard:

```json
{
  "total_active": 314,
  "discovered_today": 42,
  "discovered_this_week": 187,
  "with_referral_links": 189,
  "by_type": { "per_referral": 120, "dual": 80, "free_product": 54 },
  "by_source": { "reddit": 150, "competitor": 80, "google_cse": 35, "rss": 25, "user_submission": 24 },
  "average_score": 0.62,
  "average_engagement": 0.34,
  "total_clicks_this_week": 892
}
```

#### `POST /submissions`

**Request**:
```json
{
  "url": "https://example.co.uk/refer-a-friend",
  "submitted_by": "user_abc123"
}
```

**Response 201**: Queued for processing.
**Response 409**: URL already exists.
**Response 422**: Validation failed.
**Response 429**: User has exceeded submission rate limit (20/hour).

#### `POST /referrals/:id/click` (NEW)

User feedback endpoint. Easyearns.com calls this when a user clicks a referral link.

**Request**: No body required.

**Response 200**: Click recorded. Returns updated `referral` object with recalculated score.

**Effect**: Inserts a row into `click_events`. Increments `clicks_last_7_days` on the referral. The next score materialisation (15 min) recalculates the engagement factor.

#### `POST /referrals/:id/impression` (NEW)

Called by Easyearns.com when a referral is displayed to a user. Increments `impressions_last_7_days` on the referral.

**Request**: No body required (just the referral ID in the URL).

**Response 200**: Impression recorded.

#### `GET /health`

```json
{
  "status": "ok",
  "uptime_seconds": 86400,
  "db": "connected",
  "queries_today": {
    "google_cse": { "used": 45, "limit": 100 },
    "reddit": { "requests": 312, "limit": 5760 }
  },
  "workers": {
    "google-cse": { "last_run": "...", "last_status": "completed", "items_found": 3 },
    "reddit": { "last_run": "...", "last_status": "completed", "items_found": 12 },
    "rss": { "last_run": "...", "feeds_degraded": [] },
    "page-monitor": { "last_run": "...", "changes_detected": 1 }
  },
  "queue": { "pending": 3, "processing": 2 },
  "version": "1.0.0"
}
```

Returns 503 if any worker has 3+ consecutive failures or any feed is degraded.

#### `GET /admin/dashboard`

Requires `ADMIN_API_KEY`. Full dashboard with worker stats, queue health, extraction success rates, stale referrals, feed health status.

---

## 11. Observability & Logging

### 11.1 Structured Logging (pino)

```typescript
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  formatters: { level(label) { return { level: label } } },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() { return { requestId: correlation.getRequestId() } }
})
```

Every log line includes: timestamp, level, requestId, worker name (for workers).

### 11.2 Correlation IDs

```typescript
import { AsyncLocalStorage } from 'async_hooks'
const storage = new AsyncLocalStorage<string>()

export const correlation = {
  getRequestId: () => storage.getStore() ?? 'unknown',
  run: (id: string, fn: () => void) => storage.run(id, fn)
}
```

### 11.3 Silent Failure Detection

If any worker has `last_status = 'failed'` for 3 consecutive runs, `/health` returns `status: "degraded"` (503). UptimeRobot or cron-job.org alerts on non-200.

### 11.4 Feed Health Tracking

RSS worker maintains an in-memory `Map<feedUrl, { consecutiveEmptyRuns: number }>`. After 3 empty runs, flags feed as degraded. Reported in `/health`.

---

## 12. Test Strategy (NEW)

### 12.1 Unit Tests

| File | What It Tests |
|---|---|
| `tests/extractor/patterns.test.ts` | Every regex pattern against known-good and known-bad inputs. Captured real HTML pages as fixtures (anonymised). Each pattern has 3+ test cases. |
| `tests/deduper.test.ts` | 3-layer dedup with exact URL, content hash, and fuzzy match scenarios. Duplicate detection, merge logic. |
| `tests/scorer.test.ts` | Score formula with each weight scenario. Engagement factor calculations. Freshness decay over time. |
| `tests/uk-filter.test.ts` | Decision matrix: every row in the 5-column matrix has a test case. |
| `tests/workers/queue.test.ts` | Two-tier priority: high queue consumed first, backpressure on full queues. |

### 12.2 Integration Tests

| File | What It Tests |
|---|---|
| `tests/extractor/integration.test.ts` | End-to-end: fetch HTML → parse → extract → dedup → store. Uses mock HTTP server. |
| `tests/workers/google-cse.test.ts` | Google CSE worker with mock API responses. Tests query rotation, quota enforcement. |
| `tests/workers/reddit.test.ts` | Reddit worker with mock API. Tests UK filtering, post dedup, saturation detection. |

### 12.3 Test Infrastructure

- Vitest (fast, ESM-native, TypeScript-first)
- Mock HTTP server (`nock` or `msw`) for external API calls
- Test PostgreSQL database (created/destroyed per test suite)

### 12.4 Test Fixtures

Real HTML pages captured from referral sites (anonymised: personal info removed, URLs redacted). Stored in `tests/extractor/fixtures/`. Each fixture has a corresponding `expected.json` with the expected extraction output.

```bash
tests/extractor/fixtures/
  hellofresh.html          expected-hellofresh.json
  monzo.html               expected-monzo.json
  quidco.html              expected-quidco.json
  blog-comparison.html     expected-blog-comparison.json   # multi-offer page
  image-terms.html         expected-image-terms.json        # image-based terms
  cloudflare-challenge.html expected-cloudflare.json        # should return null
```

---

## 13. CI/CD Pipeline (NEW)

### 13.1 GitHub Actions

```yaml
# .github/workflows/ci.yml

name: CI
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: referral_discovery_test
          POSTGRES_HOST_AUTH_METHOD: trust
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run db:migrate   # run schema against test DB
      - run: npm run typecheck    # tsc --noEmit
      - run: npm run lint         # eslint
      - run: npm test             # vitest
      - run: npm run build        # tsc
```

### 13.2 Deployment (Railway)

Railway auto-deploys from the `main` branch after CI passes. Manual rollback via Railway dashboard.

```toml
# railway.toml
[build]
  builder = "nixpacks"
  buildCommand = "npm ci && npm run build"

[deploy]
  startCommand = "npm start"
  healthcheckPath = "/api/v1/health"
  healthcheckTimeout = 15
  restartPolicyMaxRetries = 3
```

### 13.3 Rollback Procedure

1. Railway dashboard → Deployments → select previous successful deploy
2. Click "Redeploy"
3. Verify `/health` returns 200
4. Check Supabase: no schema changes were rolled back (schema migrations are forward-only)

---

## 14. Graceful Shutdown

```typescript
let server: Server

async function main() {
  const app = createApp()
  server = app.listen(port)
  scheduler.start()
  logger.info({ port }, 'server started')
}

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  scheduler.stop()  // wait max 30s for running jobs
  server.close(() => {
    pool.end()
    logger.info('shutdown complete')
    process.exit(0)
  })
  setTimeout(() => { logger.error('forced shutdown'); process.exit(1) }, 25000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
main()
```

---

## 15. TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 16. Package Dependencies

```json
{
  "name": "referral-discovery",
  "version": "1.0.0",
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/ --ext .ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:migrate": "tsx src/db/migrate.ts",
    "db:seed": "tsx src/db/seed.ts",
    "db:validate-seed": "tsx src/db/validate-seed.ts"
  },
  "dependencies": {
    "express": "^5.0.0",
    "cors": "^2.8.5",
    "zod": "^3.23.0",
    "pino": "^9.0.0",
    "pg": "^8.13.0",
    "cheerio": "^1.0.0",
    "got": "^14.0.0",
    "node-cron": "^3.0.0",
    "rss-parser": "^3.13.0",
    "express-rate-limit": "^7.0.0",
    "robots-parser": "^3.0.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/cors": "^2.8.0",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "@types/node-cron": "^3.0.0",
    "typescript": "^5.6.0",
    "pino-pretty": "^11.0.0",
    "tsx": "^4.0.0",
    "eslint": "^9.0.0",
    "@typescript-eslint/eslint-plugin": "^8.0.0",
    "@typescript-eslint/parser": "^8.0.0",
    "vitest": "^2.0.0",
    "nock": "^14.0.0"
  }
}
```

**Changes from v1**: Removed `pino-pretty` from deps (it's in devDeps now). Added `cors`, `vitest`, `nock`. Kept `got` (supports HTTP/2 with `http2: true`). Kept `cheerio` (no Puppeteer needed).

---

## 17. Deployment

### 17.1 Database: Supabase (Free Tier)

```env
DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres?sslmode=require
```

1. Create project at supabase.com
2. Run `npm run db:migrate` (applies schema)
3. Run `npm run db:validate-seed` (HEAD-checks seed URLs, generates validated INSERTs)
4. Run `npm run db:seed` (inserts only validated monitored pages)

Supabase connection: direct TCP on port 5432. No PgBouncer needed for this volume. The `pool.ts` module must configure `{ ssl: { rejectUnauthorized: false } }` on the pg Pool for Supabase's required SSL connection.

### 17.2 Web Service: Railway

Minimum compute tier (~£4/month). Database is on Supabase, not Railway.

```env
# .env.example
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

DATABASE_URL=postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres?sslmode=require

GOOGLE_CSE_API_KEY=AIza...
GOOGLE_CSE_ENGINE_ID=0123456789...

REDDIT_CLIENT_ID=...
REDDIT_CLIENT_SECRET=...
REDDIT_USER_AGENT=easyearns-discovery/1.0 (by /u/your-username)

EASYEARNS_API_KEY=...
ADMIN_API_KEY=...

CORS_ORIGINS=https://easyearns.com,https://www.easyearns.com
```

### 17.3 Uptime Monitoring

cron-job.org or UptimeRobot, pinging `/api/v1/health` every 5 minutes. This also prevents Railway cold starts.

---

## 18. Implementation Phases

### Phase 1: Foundation + Google CSE — ~2.5 days

- Project scaffold (strict TypeScript, ESM, Express 5)
- Pino logger, correlation IDs, Zod validation
- PostgreSQL schema on Supabase
- Google CSE worker (UK queries)
- UK filter service
- Basic extractor (Groups 1-3 + referral code scanning)
- Dedup Layer 1 (exact URL)
- `GET /referrals`, `GET /health` endpoints
- Graceful shutdown
- Railway + Supabase deploy

### Phase 2: Reddit + RSS — ~2 days

- Reddit worker (7 UK subreddits)
- Competitor worker (non-Cloudflare sites)
- RSS worker with feed health tracking
- Dedup Layers 2-3
- Full extractor with image alt text + multi-offer splitting
- `POST /submissions` with user rate limiting
- Priority queue

### Phase 3: Page Monitor + Scoring — ~2 days

- Page monitor (validated URLs, no LIMIT, all per cycle)
- Scoring engine with engagement factor
- `app_config` table for score weights
- Score materialisation cron
- Offer change history
- `GET /referrals/changed`

### Phase 4: Engagement Loop — ~1.5 days

- `POST /referrals/:id/click` endpoint
- `click_events` table + aggregation
- `pre scoring worker engagement distribution
- Verifier worker with referral link check
- URL guesser

### Phase 5: Tests, CI/CD, Polish — ~2 days

- Extract all tests
- CI pipeline (GitHub Actions)
- Admin dashboard
- Seed validation script
- Storage management (worker_runs trim)
- Full error response standardisation
- `GET /referrals/top`, `GET /referrals/stats`

**Total**: ~10 days for one developer.

---

## 19. What This Spec Intentionally Excludes

| Excluded | Reason |
|---|---|
| Twitter/X API | $100/mo minimum |
| Puppeteer/Playwright | Too expensive for Railway. Add as upgrade later |
| LLM extraction | API costs. Regex covers 80%+ for UK offers |
| Redis / Bull | In-memory queue is sufficient |
| Docker Compose multi-service | Single process fits Railway |
| Non-UK referrals | Explicit market constraint |
| Gambling offers serving | Flagged for compliance review |
| User authentication | Easyearns handles this; we validate API keys |
| HotUKDeals / MSE scraping | Cloudflare block plain HTTP. Compensated via Google CSE |
| Push notifications | Phase 2 enhancement — `/top` endpoint serves the same purpose for now |

---

## 20. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Google CSE quota insufficient (100/day) | Medium | Low | UK-targeted queries. Reddit + competitor sources provide volume. Upgrade if revenue justifies. |
| Cloudflare on competitor sites blocks scraping | High | High | Acknowledged: HotUKDeals/MSE/etc excluded from spec. Compensated via Google CSE. |
| Google News RSS deprecated mid-lifecycle | Medium | Medium | Feed health tracking: 3 empty runs = degraded flag. Fallback sources listed in Section 2.3. |
| Seed URLs 404 on first run | High | High | Seed validation script (Section 9.4) runs before first deploy. Only validated URLs are inserted. |
| Railway credit insufficient | Medium | High | ~£4/month for minimum compute. Supabase is free. Monitor credit, no unexpected costs. |
| Reddit API rate limit blocks us | Low | Medium | 60 req/min is generous for our volume. OAuth > anonymous access. |
| Scoring weights are wrong | Medium | Medium | Engagement feedback loop (Section 7.6) corrects scoring over time. Weights via `app_config`. |
| User spams submissions | Low | Low | Per-user rate limit: 20/hour. In-memory tracking. |
| Extraction misses new phrasing patterns | High | Medium | Fallback pattern catches any £ amount. Failed extractions stored as `unknown`. Manual review. |
| Referral codes in images not extractable | Medium | Low | Image alt text scanning (Section 6.3) provides partial coverage. Not a full fix, but better than silence. |
| No competitor scraping reduces signal | Medium | Medium | Google CSE compensates. Non-Cloudflare sources still provide direct scrape signal. |

---

## 21. Success Metrics

| Metric | Target | Measurement |
|---|---|---|
| UK referrals discovered/day | 50+ | `COUNT(*) FROM referrals WHERE discovered_at > NOW() - 1 day` |
| Referrals with usable `referral_link` | >30% | `COUNT(*) WHERE referral_link IS NOT NULL / total` |
| Extraction success rate | >75% | `reward_type != 'unknown'` ratio |
| Terms changes detected/week | 5+ | `COUNT(*) FROM offer_history WHERE detected_at > 7 days` |
| API response time (p95) | <300ms | pino request logging |
| Uptime | >99% | UptimeRobot |
| Average engagement score | >0.2 | `AVG(engagement_score) WHERE is_active = true` |
| Click-through rate | >1% | `SUM(clicks_last_7_days) / SUM(impressions_last_7_days)` |

---

## Appendix A: UK Monetary Normalisation

```typescript
function parseCurrencyToGbp(value: string): number | null {
  const gbpMatch = value.match(/£\s*(\d+\.?\d*)/)
  if (gbpMatch) return parseFloat(gbpMatch[1])

  const poundTextMatch = value.match(/(\d+)\s*(?:pounds?|quid)/i)
  if (poundTextMatch) return parseFloat(poundTextMatch[1])

  const wordNumbers: Record<string, number> = {
    'ten': 10, 'tenner': 10, 'twenty': 20, 'thirty': 30, 'forty': 40,
    'fifty': 50, 'hundred': 100, 'five': 5, 'fiver': 5, 'one': 1
  }
  for (const [word, num] of Object.entries(wordNumbers)) {
    if (value.toLowerCase().includes(word)) return num
  }

  const usdMatch = value.match(/\$\s*(\d+\.?\d*)/)
  if (usdMatch) return parseFloat(usdMatch[1]) * 0.78

  return null
}
```

## Appendix B: UK-Specific Keyword Sets

```typescript
const UK_STRONG_SIGNALS = [
  'United Kingdom', 'UK', 'GB', 'Great Britain',
  'England', 'Scotland', 'Wales', 'Northern Ireland',
  'FCA', 'FSCS', 'PRA', 'Financial Conduct Authority',
  'eligible UK residents', 'UK only', 'UK residents only',
  'London', 'Manchester', 'Birmingham', 'Leeds', 'Glasgow',
  'Edinburgh', 'Liverpool', 'Bristol', 'Cardiff', 'Belfast',
]

const UK_DOMAIN_TLDS = [
  '.co.uk', '.uk', '.london', '.scot', '.wales', '.cymru',
  '.org.uk', '.me.uk', '.ac.uk', '.gov.uk', '.nhs.uk',
]
```
