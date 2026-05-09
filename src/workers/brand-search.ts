import got from 'got'
import { UK_BRANDS, getBrandSearchQueries } from '../lib/brands.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { storeReferral } from '../services/deduper.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'
import { pool } from '../db/pool.js'
import { checkQuota, incrementQuota } from '../services/quota-tracker.js'

interface SearchResult {
  title: string
  link: string
  snippet: string
}

const BRANDS_PER_CYCLE = 3

let brandIndex = 0

async function loadBrandIndex(): Promise<number> {
  try {
    const result = await pool.query<{ value: string }>(
      "SELECT value FROM app_config WHERE key = 'brand_search_index'",
    )
    return result.rows[0] ? parseInt(result.rows[0].value, 10) : 0
  } catch {
    return 0
  }
}

async function saveBrandIndex(index: number): Promise<void> {
  try {
    await pool.query(
      "INSERT INTO app_config (key, value) VALUES ('brand_search_index', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()",
      [String(index)],
    )
  } catch {
    // non-critical
  }
}

function getBrandBatch() {
  const batch = []
  for (let i = 0; i < BRANDS_PER_CYCLE; i++) {
    batch.push(UK_BRANDS[brandIndex]!)
    brandIndex = (brandIndex + 1) % UK_BRANDS.length
  }
  return batch
}

function stripWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname
}

function isBrandDomain(link: string, brandDomain: string): boolean {
  try {
    const hostname = stripWww(new URL(link).hostname)
    const brand = stripWww(brandDomain)
    return hostname === brand || hostname.endsWith(`.${brand}`)
  } catch {
    return false
  }
}

async function serperSearch(brandName: string): Promise<SearchResult[]> {
  try {
    const response = await got('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': config.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      json: { q: `"${brandName}" referral OR "refer a friend" OR "invite"`, gl: 'gb', num: 3 },
      timeout: { request: 10_000 },
    }).json<{ organic?: Array<{ title: string; link: string; snippet: string }> }>()

    return (response.organic ?? []).map(r => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet ?? '',
    }))
  } catch (err) {
    logger.warn({ err, brandName }, 'brand_search: serper search failed')
    return []
  }
}

async function braveSearch(brandName: string): Promise<SearchResult[]> {
  try {
    const response = await got('https://api.search.brave.com/res/v1/web/search', {
      headers: {
        'X-Subscription-Token': config.BRAVE_API_KEY,
        'Accept': 'application/json',
      },
      searchParams: { q: `"${brandName}" referral OR "refer a friend" OR "invite"`, country: 'GB', count: 3 },
      timeout: { request: 10_000 },
    }).json<{ web?: { results?: Array<{ title: string; url: string; description: string }> } }>()

    return (response.web?.results ?? []).map(r => ({
      title: r.title,
      link: r.url,
      snippet: r.description ?? '',
    }))
  } catch (err) {
    logger.warn({ err, brandName }, 'brand_search: brave search failed')
    return []
  }
}

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('brand_search')
  brandIndex = await loadBrandIndex()
  let processed = 0
  let discovered = 0

  try {
    const brands = getBrandBatch()

    logger.info({ count: brands.length, startIndex: brandIndex }, 'brand_search: cycle start')

    for (const brand of brands) {
      let results: SearchResult[] = []
      if (await checkQuota('serper')) {
        results = await serperSearch(brand.name)
        await incrementQuota('serper')
      }

      if (results.length === 0) {
        logger.info({ brand: brand.name }, 'brand_search: serper returned no results, trying brave fallback')
        if (await checkQuota('brave')) {
          results = await braveSearch(brand.name)
          await incrementQuota('brave')
        }
      }

      let brandProcessed = 0
      let brandDiscovered = 0

      for (const result of results) {
        if (!isBrandDomain(result.link, brand.domain)) {
          logger.debug({ url: result.link, brand: brand.name }, 'brand_search: skipping third-party result')
          continue
        }

        brandProcessed++

        try {
          const { html } = await fetch(result.link)
          const extracted = await extract(html, result.link)
          if (extracted) {
            await storeReferral(result.link, extracted, 'brand_search', 'brand_targeted')
            discovered++
            brandDiscovered++
          }
        } catch (err) {
          logger.warn({ err, url: result.link, brand: brand.name }, 'brand_search: fetch/extract failed')
        }
      }

      logger.info(
        { brand: brand.name, domain: brand.domain, results: results.length, processed: brandProcessed, discovered: brandDiscovered },
        'brand_search: brand complete',
      )

      processed += brandProcessed

      await new Promise(r => setTimeout(r, 2000))
    }

    await saveBrandIndex(brandIndex)
    await completeWorkerRun(runId, processed, discovered)
    logger.info({ processed, discovered, brandIndex }, 'brand_search: cycle complete')
  } catch (err) {
    logger.error({ err }, 'brand_search: worker fatal')
    await failWorkerRun(runId, String(err))
  }
}
