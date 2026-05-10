import * as cheerio from 'cheerio'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { checkUkMarket } from '../services/uk-filter.js'
import { storeReferral } from '../services/deduper.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'
import { retry } from '../lib/retry.js'

interface CompetitorSource {
  name: string
  url: string
  parser: ($: cheerio.CheerioAPI, baseUrl: string) => Promise<Array<{ title: string; url: string; text: string }>>
}

async function parseLatestDeals($: cheerio.CheerioAPI, _baseUrl: string): Promise<Array<{ title: string; url: string; text: string }>> {
  const results: Array<{ title: string; url: string; text: string }> = []
  $('.deal-card, .deal-item, article, .listing-item').each((_, el) => {
    const title = $(el).find('h2, h3, .title, .deal-title').first().text().trim()
    const link = $(el).find('a[href]').first().attr('href')
    const desc = $(el).find('.description, .snippet, p').first().text().trim()
    if (title && link) {
      const fullUrl = link.startsWith('http') ? link : `https://latestdeals.co.uk${link}`
      results.push({ title, url: fullUrl, text: `${title} ${desc}` })
    }
  })
  return results.slice(0, 20)
}

async function parseMagicFreebies($: cheerio.CheerioAPI, _baseUrl: string): Promise<Array<{ title: string; url: string; text: string }>> {
  const results: Array<{ title: string; url: string; text: string }> = []
  $('article, .post, .freebie-item, .listing-item').each((_, el) => {
    const title = $(el).find('h2, h3, .entry-title').first().text().trim()
    const link = $(el).find('a[href]').first().attr('href')
    const desc = $(el).find('.entry-content, .excerpt').first().text().trim()
    const combined = `${title} ${desc}`
    // Filter: must contain referral-related keywords
    if ((title || desc) && /refer|invite|free.*sign|free.*box|free.*delivery|referral/i.test(combined)) {
      if (link) {
        const fullUrl = link.startsWith('http') ? link : `https://magicfreebiesuk.co.uk${link}`
        results.push({ title, url: fullUrl, text: combined })
      }
    }
  })
  return results.slice(0, 20)
}

async function parseBeClever($: cheerio.CheerioAPI, _baseUrl: string): Promise<Array<{ title: string; url: string; text: string }>> {
  const results: Array<{ title: string; url: string; text: string }> = []
  $('article, .post, .entry').each((_, el) => {
    const title = $(el).find('h2, h3, .entry-title').first().text().trim()
    const link = $(el).find('a[href]').first().attr('href')
    const desc = $(el).find('.entry-content, .excerpt').first().text().trim()
    const combined = `${title} ${desc}`
    // Filter for switching bonuses and referral
    if ((title || desc) && /switching|switch|bonus|refer|referral/i.test(combined)) {
      if (link) {
        const fullUrl = link.startsWith('http') ? link : `https://becleverwithyourcash.co.uk${link}`
        results.push({ title, url: fullUrl, text: combined })
      }
    }
  })
  return results.slice(0, 20)
}

async function parseQuidco($: cheerio.CheerioAPI, baseUrl: string): Promise<Array<{ title: string; url: string; text: string }>> {
  return parseGenericReferralPage($, baseUrl, 'quidco.com')
}

async function parseTopCashback($: cheerio.CheerioAPI, baseUrl: string): Promise<Array<{ title: string; url: string; text: string }>> {
  return parseGenericReferralPage($, baseUrl, 'topcashback.co.uk')
}

function parseGenericReferralPage($: cheerio.CheerioAPI, baseUrl: string, hostname: string): Array<{ title: string; url: string; text: string }> {
  const results: Array<{ title: string; url: string; text: string }> = []
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    const text = $(el).text().trim()
    if (href && text && /refer|invite/i.test(`${href} ${text}`)) {
      const fullUrl = href.startsWith('http') ? href : `https://${hostname}${href}`
      results.push({ title: text, url: fullUrl, text })
    }
  })
  return results.slice(0, 10)
}

const SOURCES: CompetitorSource[] = [
  { name: 'latestdeals', url: 'https://www.latestdeals.co.uk/search?q=refer+a+friend&order=newest', parser: parseLatestDeals },
  { name: 'magicfreebiesuk', url: 'https://magicfreebiesuk.co.uk/', parser: parseMagicFreebies },
  { name: 'becleverwithyourcash', url: 'https://www.becleverwithyourcash.co.uk/best-bank-switching-offers/', parser: parseBeClever },
  { name: 'quidco', url: 'https://www.quidco.com/refer-a-friend/', parser: parseQuidco },
  { name: 'topcashback', url: 'https://www.topcashback.co.uk/refer/', parser: parseTopCashback },
  { name: 'moneytothemasses', url: 'https://www.moneytothemasses.com/', parser: async ($, baseUrl) => {
    const results: Array<{ title: string; url: string; text: string }> = []
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      const text = $(el).text().trim()
      if (href && text && /refer|bonus|switch|join/i.test(href + text) && href.includes('moneytothemasses')) {
        results.push({ title: text, url: href.startsWith('http') ? href : baseUrl + href, text })
      }
    })
    return results.slice(0, 10)
  }},
  { name: 'savethestudent', url: 'https://www.savethestudent.org/banking', parser: async ($, baseUrl) => {
    const results: Array<{ title: string; url: string; text: string }> = []
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      const text = $(el).text().trim()
      if (href && text && /refer|free|bonus|switch/i.test(href + text) && (href.includes('savethestudent') || href.startsWith('http'))) {
        results.push({ title: text, url: href.startsWith('http') ? href : 'https://www.savethestudent.org' + href, text })
      }
    })
    return results.slice(0, 10)
  }},
  { name: 'moneymagpie', url: 'https://www.moneymagpie.com/', parser: async ($, baseUrl) => {
    const results: Array<{ title: string; url: string; text: string }> = []
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href')
      const text = $(el).text().trim()
      if (href && text && /refer|free|bonus|switch|cash/i.test(href + text)) {
        results.push({ title: text, url: href.startsWith('http') ? href : baseUrl + href, text })
      }
    })
    return results.slice(0, 10)
  }},
]

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('competitor')
  let totalProcessed = 0
  let totalDiscovered = 0

  try {
    for (const source of SOURCES) {
      try {
        const { html } = await retry(
          () => fetch(source.url),
          { retries: 2, minTimeout: 2_000 },
        )

        const $ = cheerio.load(html)
        const results = await source.parser($, source.url)
        totalProcessed += results.length

        for (const item of results) {
          // UK filter check
          const ukCheck = checkUkMarket(item.url, item.text)
          if (!ukCheck.pass) {
            logger.debug({ source: source.name, url: item.url, reason: ukCheck.reason }, 'skipping non-UK competitor result')
            continue
          }

          try {
            const { html: pageHtml } = await fetch(item.url)
            const extracted = await extract(pageHtml, item.url)

            if (extracted) {
              await storeReferral(item.url, extracted, `competitor_${source.name}`, ukCheck.signal)
              totalDiscovered++
            }
          } catch (err) {
            logger.warn({ err, source: source.name, url: item.url }, 'failed to process competitor URL')
          }

          // Per-domain rate limiting: 5s between requests
          await new Promise(r => setTimeout(r, 5_000))
        }

        logger.info({ source: source.name, processed: results.length }, 'competitor source processed')
      } catch (err) {
        logger.warn({ err, source: source.name }, 'competitor source failed')
      }
    }

    await completeWorkerRun(runId, totalProcessed, totalDiscovered)
    logger.info({ processed: totalProcessed, discovered: totalDiscovered }, 'competitor worker complete')
  } catch (err) {
    logger.error({ err }, 'competitor worker fatal error')
    await failWorkerRun(runId, String(err))
  }
}
