# NOTES.md — ReferralRadar

## Current Status (11 May 2026, ~3am)

LIVE at https://referralradar-production.up.railway.app

### Working
- 15 cron workers running, all healthy
- 5 discovery sources: Serper, Brave, Reddit, Competitors, RSS, Brand Search
- 230+ UK brands with categories
- Admin dashboard: 4 tabs, search, edit, delete, batch categorize, worker restart
- Public API: Easyearns-ready format (brand, logo_url, category, has_link)
- Uptime pinger via cron-job.org (every 5 min)
- 39 vitest tests passing

### Known issues needing attention
- Reddit gets 403 sometimes — UA string helps but flaky
- RSS feeds: AltFi and UKTN broken — need updated feed URLs
- Many referrals still "uncategorised" (29 as of last check) — brand list needs continuous expansion
- Referral link extraction at ~39% — scripts/meta extractor helped but more work needed
- Name resolution sometimes falls back to HTML titles (pipe-separated garbage)

### Next improvements (prioritized)
1. Expand brand list with more UK companies (especially ones Easyearns already has: Klarna, Whatnot, Tembo, etc.)
2. Fix broken RSS feeds (AltFi + UKTN)
3. Improve Reddit reliability (browser-like UA needed)
4. Add more easyearns.com target brands
5. Score tuning based on real engagement data

### Deployment notes
- `git push` to main auto-deploys via Railway
- Can also deploy via `railway up` from project directory
- Need to re-link Railway each session: `railway project link --project ReferralRadar -w 56e3f637-80dc-45d6-912a-1adf539cdead && railway service link ReferralRadar`
- `npm run dev` for local (needs .env with DATABASE_URL pointing to pooler)

### Key files
- src/index.ts — entry, worker scheduling
- src/services/extractor.ts — HTML parsing + referral link extraction
- src/services/deduper.ts — 3-layer dedup + quality gate + brand resolution
- src/lib/brands.ts — 230+ UK brands with categories
- src/lib/blocklist.ts — spam/aggregator domains
- src/routes/admin.ts — interactive dashboard HTML + JS
- src/routes/admin-api.ts — admin CRUD endpoints
- src/workers/search.ts — Serper + Brave search
- src/workers/brand-search.ts — targeted brand queries
- src/db/schema.sql — full schema + functions + indexes
