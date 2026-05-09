import got from 'got'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { checkUkMarket } from '../services/uk-filter.js'
import { storeReferral } from '../services/deduper.js'
import { getCseQuotaUsed, incrementCseQuota, insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'

const DAILY_LIMIT = 100

interface GoogleCseResult {
  title: string
  link: string
  snippet: string
}

const UK_QUERIES = [
  // Group A — New launches
  '"refer a friend" "just launched" UK',
  '"introducing our referral programme" UK',
  '"new refer a friend" "sign up" UK',
  '"announcing our referral" "earn" UK',
  // Group B — Terms pages with explicit £
  '"refer a friend" "terms and conditions" site:co.uk',
  '"referral programme" "you\'ll receive £" UK',
  '"refer a friend" "we\'ll give you £" UK',
  '"referral code" "get £" site:co.uk',
  // Group C — Generic UK pages
  '"share your link" "earn £" UK',
  '"invite your friends" "free" UK',
  '"referral code" "UK" "bonus"',
  '"refer a friend" "referral bonus" site:co.uk',
  // Group D — UK industries
  '"bank switching" "refer a friend" UK',
  '"refer a friend" "free box" UK',
  '"referral" trading app UK "free share"',
  '"refer" energy supplier UK "£50"',
  '"restaurant referral" "free meal" UK',
  // Group E — Terms changes
  '"we\'ve increased our referral" UK',
  '"referral bonus increased" UK',
  '"updated" "refer a friend" terms UK',
  '"refer a friend" "changes" UK',
]

let queryIndex = 0

function getNextQuery(): string {
  const query = UK_QUERIES[queryIndex]!
  queryIndex = (queryIndex + 1) % UK_QUERIES.length
  return query
}

async function searchCse(query: string): Promise<GoogleCseResult[]> {
  const url = `https://www.googleapis.com/customsearch/v1?key=${config.GOOGLE_CSE_KEY}&cx=${config.GOOGLE_CSE_ID}&q=${encodeURIComponent(query)}&gl=gb&num=10`
  const response = await got(url, { timeout: { request: 15_000 } }).json<{
    items?: Array<{ title: string; link: string; snippet: string }>
  }>()
  return response.items ?? []
}

// Domains to skip (aggregators, forums we already cover via Reddit)
const SKIP_DOMAINS = [
  'reddit.com', 'latestdeals.co.uk', 'magicfreebiesuk.co.uk',
  'becleverwithyourcash.co.uk', 'quidco.com', 'topcashback.co.uk',
  'hotukdeals.com', 'moneysavingexpert.com',
  'myvouchercodes.co.uk', 'vouchercodes.co.uk',
  'forums.moneysavingexpert.com',
]

function isSkippableDomain(link: string): boolean {
  try {
    const hostname = new URL(link).hostname.replace(/^www\./, '')
    return SKIP_DOMAINS.some(d => hostname.endsWith(d))
  } catch {
    return true
  }
}

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('google-cse')
  let itemsProcessed = 0
  let itemsDiscovered = 0

  try {
    const used = await getCseQuotaUsed()
    const remaining = DAILY_LIMIT - used

    if (remaining <= 0) {
      logger.info({ used, limit: DAILY_LIMIT }, 'CSE quota exhausted for today')
      await completeWorkerRun(runId, 0, 0)
      return
    }

    // Run up to 5 queries per cycle (max: 5 x 10 = 50 results, leaving headroom)
    const queriesToRun = Math.min(5, remaining)

    for (let i = 0; i < queriesToRun; i++) {
      const query = getNextQuery()
      logger.info({ query }, 'running CSE query')

      try {
        const results = await searchCse(query)
        await incrementCseQuota()
        itemsProcessed += results.length

        for (const result of results) {
          if (isSkippableDomain(result.link)) {
            logger.debug({ url: result.link }, 'skipping known aggregator/forum domain')
            continue
          }

          // UK filter check
          const ukCheck = checkUkMarket(result.link, result.title + ' ' + result.snippet)
          if (!ukCheck.pass) {
            logger.debug({ url: result.link, reason: ukCheck.reason }, 'skipping non-UK CSE result')
            continue
          }

          try {
            const { html } = await fetch(result.link)
            const extracted = await extract(html, result.link)

            if (extracted) {
              await storeReferral(result.link, extracted, 'google_cse', ukCheck.signal)
              itemsDiscovered++
            }
          } catch (err) {
            logger.warn({ err, url: result.link }, 'failed to process CSE result')
          }
        }
      } catch (err) {
        logger.error({ err, query }, 'CSE query failed')
      }

      // Yields between queries
      if (i < queriesToRun - 1) {
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    await completeWorkerRun(runId, itemsProcessed, itemsDiscovered)
    logger.info({ itemsProcessed, itemsDiscovered, queriesRun: queriesToRun }, 'CSE worker complete')
  } catch (err) {
    logger.error({ err }, 'CSE worker fatal error')
    await failWorkerRun(runId, String(err))
  }
}
