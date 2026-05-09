import got from 'got'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { checkUkMarket } from '../services/uk-filter.js'
import { storeReferral } from '../services/deduper.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'

interface RedditPost {
  id: string
  title: string
  selftext: string
  url: string
  permalink: string
  score: number
  num_comments: number
  created_utc: number
}

interface RedditListing {
  kind: 'Listing'
  data: {
    children: Array<{
      kind: 't3'
      data: {
        id: string
        title: string
        selftext: string
        url: string
        permalink: string
        score: number
        num_comments: number
        created_utc: number
      }
    }>
  }
}

const REDDIT_BASE = 'https://www.reddit.com'

const PRIMARY_SUBS: Array<{ sub: string; endpoint: string }> = [
  { sub: 'r/beermoneyuk', endpoint: '/r/beermoneyuk/new.json?limit=25' },
]

const SECONDARY_SUBS: Array<{ sub: string; endpoint: string }> = [
  { sub: 'r/UKPersonalFinance', endpoint: '/r/UKPersonalFinance/search.json?q=referral&sort=new&restrict_sr=on&limit=25' },
  { sub: 'r/MakeMoneyInUK', endpoint: '/r/MakeMoneyInUK/new.json?limit=25' },
  { sub: 'r/signupsforpay', endpoint: '/r/signupsforpay/search.json?q=£&sort=new&restrict_sr=on&limit=25' },
]

const TERTIARY_SUBS: Array<{ sub: string; endpoint: string }> = [
  { sub: 'r/UKFrugal', endpoint: '/r/UKFrugal/new.json?limit=25' },
  { sub: 'r/UKDeals', endpoint: '/r/UKDeals/search.json?q=referral&sort=new&restrict_sr=on&limit=25' },
  { sub: 'r/referralcodes', endpoint: '/r/referralcodes/search.json?q=UK+OR+£&sort=new&restrict_sr=on&limit=25' },
]

const AGGREGATOR_DOMAINS = [
  'reddit.com', 'hotukdeals.com', 'moneysavingexpert.com',
  'latestdeals.co.uk', 'magicfreebiesuk.co.uk', 'vouchercodes.co.uk',
  'myvouchercodes.co.uk', 'quidco.com', 'topcashback.co.uk',
]

const SKIP_URL_PATTERNS = [
  /comment\.html$/,
  /\/comments\//,
]

const SATURATION_THRESHOLD_SCORE = 50
const SATURATION_THRESHOLD_COMMENTS = 20

let lastProcessedPostIds = new Set<string>()
const MAX_PROCESSED_POSTS = 5000

function extractUrls(text: string): string[] {
  const urls: string[] = []
  const urlPattern = /https?:\/\/[^\s"'<>\[\]()]+/g
  let match
  while ((match = urlPattern.exec(text)) !== null) {
    urls.push(match[0]!)
  }
  return urls
}

function isAggregatorUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    return AGGREGATOR_DOMAINS.some(d => hostname.endsWith(d))
  } catch {
    return true
  }
}

function isSkippableUrl(url: string): boolean {
  return SKIP_URL_PATTERNS.some(p => p.test(url))
}

function getPostId(url: string): string | null {
  const match = url.match(/\/comments\/([a-z0-9]+)/i)
  return match?.[1] ?? null
}

async function fetchSubreddit(endpoint: string): Promise<RedditPost[]> {
  const url = `${REDDIT_BASE}${endpoint}`
  const headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; ReferralRadar/1.0; +https://referralradar-production.up.railway.app)',
    'Accept': 'application/json',
  }

  try {
    const response = await got(url, {
      headers,
      timeout: { request: 15_000 },
      http2: true,
    }).json<RedditListing>()

    return (response.data?.children ?? [])
      .filter(c => c.kind === 't3')
      .map(c => c.data)
  } catch (err) {
    logger.warn({ err, url }, 'reddit fetch failed')
    return []
  }
}

async function processPost(post: RedditPost): Promise<number> {
  let discovered = 0

  // Skip if already processed
  if (lastProcessedPostIds.has(post.id)) return 0

  // Trim processed set
  if (lastProcessedPostIds.size > MAX_PROCESSED_POSTS) {
    const arr = [...lastProcessedPostIds]
    lastProcessedPostIds = new Set(arr.slice(arr.length - MAX_PROCESSED_POSTS / 2))
  }
  lastProcessedPostIds.add(post.id)

  // Saturation signal
  const isSaturated = post.score > SATURATION_THRESHOLD_SCORE && post.num_comments > SATURATION_THRESHOLD_COMMENTS

  // Extract URLs from selftext
  const urls = extractUrls(post.selftext)
    .filter(u => !isAggregatorUrl(u) && !isSkippableUrl(u))

  // Also process the linked URL if it is not a Reddit self post
  if (post.url && !post.url.includes('reddit.com') && !isAggregatorUrl(post.url) && !isSkippableUrl(post.url)) {
    urls.unshift(post.url)
  }

  // UK filter check on the post text
  const combinedText = `${post.title} ${post.selftext}`
  const ukCheck = checkUkMarket(post.url, combinedText)

  if (!ukCheck.pass) {
    logger.debug({ postId: post.id, title: post.title, reason: ukCheck.reason }, 'skipping non-UK reddit post')
    return 0
  }

  for (const url of urls) {
    try {
      const { html } = await fetch(url)
      const extracted = await extract(html, url)

      if (extracted) {
        await storeReferral(
          url,
          extracted,
          'reddit',
          ukCheck.signal,
          post.id,
          isSaturated ? post.score : post.score,
          isSaturated ? post.num_comments : post.num_comments,
        )
        discovered++
      }
    } catch (err) {
      logger.warn({ err, url, postId: post.id }, 'failed to process reddit URL')
    }
  }

  return discovered
}

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('reddit')
  let totalDiscovered = 0

  try {
    // Primary subs — always run
    for (const sub of PRIMARY_SUBS) {
      const posts = await fetchSubreddit(sub.endpoint)
      for (const post of posts) {
        totalDiscovered += await processPost(post)
      }
      await new Promise(r => setTimeout(r, 1_000)) // Rate limit between subs
    }

    // Secondary subs — skip if primary found a lot
    for (const sub of SECONDARY_SUBS) {
      const posts = await fetchSubreddit(sub.endpoint)
      for (const post of posts) {
        totalDiscovered += await processPost(post)
      }
      await new Promise(r => setTimeout(r, 1_000))
    }

    await completeWorkerRun(runId, PRIMARY_SUBS.length + SECONDARY_SUBS.length, totalDiscovered)
    logger.info({ discovered: totalDiscovered }, 'reddit worker complete')
  } catch (err) {
    logger.error({ err }, 'reddit worker fatal error')
    await failWorkerRun(runId, String(err))
  }
}

// Tertiary subs — run separately at lower frequency
export async function runTertiary(): Promise<void> {
  const runId = await insertWorkerRun('reddit-tertiary')
  let totalDiscovered = 0

  try {
    for (const sub of TERTIARY_SUBS) {
      const posts = await fetchSubreddit(sub.endpoint)
      for (const post of posts) {
        totalDiscovered += await processPost(post)
      }
      await new Promise(r => setTimeout(r, 1_000))
    }

    await completeWorkerRun(runId, TERTIARY_SUBS.length, totalDiscovered)
    logger.info({ discovered: totalDiscovered }, 'reddit tertiary worker complete')
  } catch (err) {
    logger.error({ err }, 'reddit tertiary worker fatal error')
    await failWorkerRun(runId, String(err))
  }
}
