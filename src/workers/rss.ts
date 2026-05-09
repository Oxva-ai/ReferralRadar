import RssParser from 'rss-parser'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { checkUkMarket } from '../services/uk-filter.js'
import { storeReferral } from '../services/deduper.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'

interface FeedConfig {
  name: string
  url: string
  tier: 'primary' | 'secondary' | 'tertiary' | 'degraded'
}

const parser = new RssParser({
  timeout: 15_000,
  headers: {
    'User-Agent': 'referral-discovery/1.0 (UK referral discovery service)',
  },
})

// Feed health tracking: consecutive empty runs per feed
const feedHealth = new Map<string, { consecutiveEmptyRuns: number; lastStatus: 'ok' | 'empty' | 'error'; lastRunAt: Date }>()

const FEEDS: FeedConfig[] = [
  // Primary — every 30 min
  { name: 'altfi', url: 'https://www.altfi.com/feed', tier: 'primary' },
  { name: 'uktn', url: 'https://www.uktn.co.uk/feed', tier: 'primary' },
  // Secondary — every 60 min
  { name: 'finextra', url: 'https://www.finextra.com/rss.aspx?topic=retail', tier: 'secondary' },
  { name: 'crowdfundinsider', url: 'https://www.crowdfundinsider.com/feed/', tier: 'secondary' },
  { name: 'producthunt', url: 'https://www.producthunt.com/feed', tier: 'secondary' },
  { name: 'hackernews', url: 'https://news.ycombinator.com/rss', tier: 'secondary' },
  // Tertiary — every 2 hours
  { name: 'thisismoney', url: 'https://www.thisismoney.co.uk/money/saving/rss', tier: 'tertiary' },
  { name: 'becleverwithyourcash', url: 'https://www.becleverwithyourcash.co.uk/feed/', tier: 'tertiary' },
  // Degraded — monitored but unreliable
  { name: 'googlenews_refer', url: 'https://news.google.com/rss/search?q=%22refer+a+friend%22+UK&hl=en-GB&gl=GB&ceid=GB:en', tier: 'degraded' },
  { name: 'googlenews_referral', url: 'https://news.google.com/rss/search?q=%22referral+programme%22+launch&hl=en-GB&gl=GB&ceid=GB:en', tier: 'degraded' },
]

const REFERRAL_KEYWORDS = [
  'refer a friend', 'referral', 'sign up', 'sign-up',
  'free share', 'free box', 'cashback', 'switching bonus',
  'bank switching', 'refer-a-friend', 'invite', 'invite friends',
  'referral code', 'earn', 'bonus', 'reward',
]

function matchesReferralKeywords(text: string): boolean {
  const lower = text.toLowerCase()
  return REFERRAL_KEYWORDS.some(kw => lower.includes(kw))
}

async function processFeed(feed: FeedConfig, tier: string): Promise<{ items: number; discovered: number }> {
  let items = 0
  let discovered = 0

  const healthKey = `${tier}:${feed.name}`
  if (!feedHealth.has(healthKey)) {
    feedHealth.set(healthKey, { consecutiveEmptyRuns: 0, lastStatus: 'ok', lastRunAt: new Date() })
  }

  try {
    const parsed = await parser.parseURL(feed.url)
    const entries = parsed.items ?? []
    items = entries.length

    if (entries.length === 0) {
      const health = feedHealth.get(healthKey)!
      health.consecutiveEmptyRuns++
      health.lastStatus = 'empty'
      health.lastRunAt = new Date()

      if (health.consecutiveEmptyRuns >= 3) {
        logger.warn({ feed: feed.name, consecutiveEmpty: health.consecutiveEmptyRuns }, 'feed degraded: 3+ consecutive empty runs')
      }
      return { items: 0, discovered: 0 }
    }

    // Reset empty run counter on success
    const health = feedHealth.get(healthKey)!
    health.consecutiveEmptyRuns = 0
    health.lastStatus = 'ok'
    health.lastRunAt = new Date()

    // Process each entry
    for (const entry of entries) {
      const title = entry.title ?? ''
      const content = entry.content ?? entry.contentSnippet ?? ''
      const combined = `${title} ${content}`

      // Check if the feed item itself matches referral keywords
      if (!matchesReferralKeywords(combined)) continue

      // Extract URLs from content
      const link = entry.link ?? ''
      if (!link) continue

      // UK filter check
      const ukCheck = checkUkMarket(link, combined)
      if (!ukCheck.pass) {
        logger.debug({ feed: feed.name, url: link, reason: ukCheck.reason }, 'skipping non-UK RSS item')
        continue
      }

      try {
        const { html } = await fetch(link)
        const extracted = await extract(html, link)

        if (extracted) {
          await storeReferral(link, extracted, `rss_${feed.name}`, ukCheck.signal)
          discovered++
        }
      } catch (err) {
        logger.warn({ err, feed: feed.name, url: link }, 'failed to process RSS link')
      }

      // Rate limiting between fetches
      await new Promise(r => setTimeout(r, 2_000))
    }

    return { items, discovered }
  } catch (err) {
    const health = feedHealth.get(healthKey)!
    health.lastStatus = 'error'
    health.lastRunAt = new Date()
    logger.warn({ err, feed: feed.name }, 'RSS feed fetch failed')
    return { items: 0, discovered: 0 }
  }
}

export function getDegradedFeeds(): string[] {
  const degraded: string[] = []
  for (const [key, health] of feedHealth) {
    if (health.consecutiveEmptyRuns >= 3) {
      degraded.push(key)
    }
  }
  return degraded
}

export function getFeedHealth(): Record<string, { consecutiveEmptyRuns: number; lastStatus: string; lastRunAt: Date }> {
  return Object.fromEntries(feedHealth)
}

export async function run(): Promise<void> {
  await runTier('primary')
}

export async function runSecondary(): Promise<void> {
  await runTier('secondary')
}

export async function runTertiary(): Promise<void> {
  await runTier('tertiary')
}

async function runTier(tier: string): Promise<void> {
  const feeds = FEEDS.filter(f => tier === 'tertiary' ? (f.tier === 'tertiary' || f.tier === 'degraded') : f.tier === tier)
  if (feeds.length === 0) return

  const runId = await insertWorkerRun(`rss-${tier}`)
  let totalItems = 0
  let totalDiscovered = 0

  try {
    for (const feed of feeds) {
      logger.debug({ feed: feed.name, tier }, 'processing RSS feed')
      const result = await processFeed(feed, tier)
      totalItems += result.items
      totalDiscovered += result.discovered
    }

    const degraded = getDegradedFeeds()
    if (degraded.length > 0) {
      logger.warn({ degraded }, 'RSS feeds degraded')
    }

    await completeWorkerRun(runId, totalItems, totalDiscovered)
    logger.info({ items: totalItems, discovered: totalDiscovered, tier }, 'RSS worker complete')
  } catch (err) {
    logger.error({ err, tier }, 'RSS worker fatal error')
    await failWorkerRun(runId, String(err))
  }
}
