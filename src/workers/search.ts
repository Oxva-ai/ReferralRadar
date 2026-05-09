import got from 'got'
import { config } from '../config.js'
import { isSkipDomain } from '../lib/blocklist.js'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { checkUkMarket } from '../services/uk-filter.js'
import { storeReferral } from '../services/deduper.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'
import { checkQuota, incrementQuota } from '../services/quota-tracker.js'

interface SearchResult {
  title: string
  link: string
  snippet: string
}

const UK_QUERIES = [
  '"refer a friend" "just launched" UK',
  '"introducing our referral programme" UK',
  '"referral code" "get £" UK',
  '"bank switching" "refer a friend" UK',
  '"share your link" "earn £" UK',
  '"refer a friend" "free box" UK',
  '"referral" trading app UK "free share"',
  '"refer" energy supplier UK',
]

let queryIndex = 0

function getNextQuery(): string {
  const query = UK_QUERIES[queryIndex]!
  queryIndex = (queryIndex + 1) % UK_QUERIES.length
  return query
}

async function serperSearch(query: string): Promise<SearchResult[]> {
  try {
    const response = await got('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': config.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      json: { q: query, gl: 'gb', num: 10 },
      timeout: { request: 10_000 },
    }).json<{ organic?: Array<{ title: string; link: string; snippet: string }> }>()

    return (response.organic ?? []).map(r => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet ?? '',
    }))
  } catch (err) {
    logger.warn({ err, query }, 'serper search failed')
    return []
  }
}

async function braveSearch(query: string): Promise<SearchResult[]> {
  try {
    const response = await got('https://api.search.brave.com/res/v1/web/search', {
      headers: {
        'X-Subscription-Token': config.BRAVE_API_KEY,
        'Accept': 'application/json',
      },
      searchParams: { q: query, country: 'GB', count: 10 },
      timeout: { request: 10_000 },
    }).json<{ web?: { results?: Array<{ title: string; url: string; description: string }> } }>()

    return (response.web?.results ?? []).map(r => ({
      title: r.title,
      link: r.url,
      snippet: r.description ?? '',
    }))
  } catch (err) {
    logger.warn({ err, query }, 'brave search failed')
    return []
  }
}

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('search')
  let processed = 0
  let discovered = 0

  try {
    // Run 3 queries per cycle, alternating Serper and Brave
    for (let i = 0; i < 3; i++) {
      const query = getNextQuery()

      // Serper (free: 2500/mo → ~83/day)
      let serperResults: SearchResult[] = []
      if (await checkQuota('serper')) {
        serperResults = await serperSearch(query)
        await incrementQuota('serper')
      } else {
        logger.warn('search: Serper quota exhausted, skipping')
      }
      for (const result of serperResults) {
        processed++
        if (isSkipDomain(result.link)) continue

        const ukCheck = checkUkMarket(result.link, result.title + ' ' + result.snippet)
        if (!ukCheck.pass) continue

        try {
          const { html } = await fetch(result.link)
          const extracted = await extract(html, result.link)
          if (extracted) {
            await storeReferral(result.link, extracted, 'serper', ukCheck.signal)
            discovered++
          }
        } catch (err) {
          logger.warn({ err, url: result.link }, 'serper fetch failed')
        }
      }

      // Brave (free: 2000/mo → ~66/day)
      let braveResults: SearchResult[] = []
      if (await checkQuota('brave')) {
        braveResults = await braveSearch(query)
        await incrementQuota('brave')
      } else {
        logger.warn('search: Brave quota exhausted, skipping')
      }
      for (const result of braveResults) {
        processed++
        if (isSkipDomain(result.link)) continue

        const ukCheck = checkUkMarket(result.link, result.title + ' ' + result.snippet)
        if (!ukCheck.pass) continue

        try {
          const { html } = await fetch(result.link)
          const extracted = await extract(html, result.link)
          if (extracted) {
            await storeReferral(result.link, extracted, 'brave', ukCheck.signal)
            discovered++
          }
        } catch (err) {
          logger.warn({ err, url: result.link }, 'brave fetch failed')
        }
      }

      if (i < 2) await new Promise(r => setTimeout(r, 2_000))
    }

    await completeWorkerRun(runId, processed, discovered)
    logger.info({ processed, discovered }, 'search worker complete')
  } catch (err) {
    logger.error({ err }, 'search worker fatal')
    await failWorkerRun(runId, String(err))
  }
}
