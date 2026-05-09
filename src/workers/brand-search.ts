import got from 'got'
import { UK_BRANDS, getBrandSearchQueries } from '../lib/brands.js'
import { config } from '../config.js'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { storeReferral } from '../services/deduper.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'

interface SearchResult {
  title: string
  link: string
  snippet: string
}

const BRANDS_PER_CYCLE = 10

let brandIndex = 0

function getBrandBatch() {
  const batch = []
  for (let i = 0; i < BRANDS_PER_CYCLE; i++) {
    batch.push(UK_BRANDS[brandIndex]!)
    brandIndex = (brandIndex + 1) % UK_BRANDS.length
  }
  return batch
}

function isBrandDomain(link: string, brandDomain: string): boolean {
  try {
    const hostname = new URL(link).hostname
    return hostname === brandDomain || hostname.endsWith(`.${brandDomain}`)
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

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('brand_search')
  let processed = 0
  let discovered = 0

  try {
    const brands = getBrandBatch()

    logger.info({ count: brands.length, startIndex: brandIndex }, 'brand_search: cycle start')

    for (const brand of brands) {
      logger.info({ brand: brand.name, domain: brand.domain }, 'brand_search: processing brand')

      const results = await serperSearch(brand.name)

      for (const result of results) {
        if (!isBrandDomain(result.link, brand.domain)) {
          logger.debug({ url: result.link, brand: brand.name }, 'brand_search: skipping third-party result')
          continue
        }

        processed++

        try {
          const { html } = await fetch(result.link)
          const extracted = await extract(html, result.link)
          if (extracted) {
            await storeReferral(result.link, extracted, 'brand_search', 'brand_targeted')
            discovered++
          }
        } catch (err) {
          logger.warn({ err, url: result.link, brand: brand.name }, 'brand_search: fetch/extract failed')
        }
      }
    }

    await completeWorkerRun(runId, processed, discovered)
    logger.info({ processed, discovered, brandIndex }, 'brand_search: cycle complete')
  } catch (err) {
    logger.error({ err }, 'brand_search: worker fatal')
    await failWorkerRun(runId, String(err))
  }
}
