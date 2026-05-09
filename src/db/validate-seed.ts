import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { headCheck } from '../services/fetcher.js'
import { fetch } from '../services/fetcher.js'
import { computeContentHash } from '../lib/hash.js'
import { logger } from '../logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SEED_URLS: Array<{ url: string; company_name: string }> = [
  { url: 'https://monzo.com/referral', company_name: 'Monzo' },
  { url: 'https://www.starlingbank.com/refer-a-friend', company_name: 'Starling Bank' },
  { url: 'https://revolut.com/referral', company_name: 'Revolut' },
  { url: 'https://wise.com/invite', company_name: 'Wise' },
  { url: 'https://www.chase.co.uk/refer-a-friend', company_name: 'Chase UK' },
  { url: 'https://www.kroo.com/refer', company_name: 'Kroo' },
  { url: 'https://www.zopa.com/refer', company_name: 'Zopa' },
  { url: 'https://www.paypal.com/uk/refer', company_name: 'PayPal' },
  { url: 'https://curve.com/refer-a-friend', company_name: 'Curve' },
  { url: 'https://www.trading212.com/refer', company_name: 'Trading 212' },
  { url: 'https://freetrade.io/refer-a-friend', company_name: 'Freetrade' },
  { url: 'https://www.etoro.com/referral', company_name: 'eToro' },
  { url: 'https://www.nutmeg.com/refer-a-friend', company_name: 'Nutmeg' },
  { url: 'https://www.moneyboxapp.com/refer', company_name: 'Moneybox' },
  { url: 'https://www.pensionbee.com/refer', company_name: 'PensionBee' },
  { url: 'https://www.hellofresh.co.uk/refer', company_name: 'HelloFresh' },
  { url: 'https://www.gousto.co.uk/refer-a-friend', company_name: 'Gousto' },
  { url: 'https://deliveroo.co.uk/refer', company_name: 'Deliveroo' },
  { url: 'https://www.ubereats.com/uk/refer', company_name: 'Uber Eats' },
  { url: 'https://www.quidco.com/refer-a-friend', company_name: 'Quidco' },
  { url: 'https://www.topcashback.co.uk/refer', company_name: 'TopCashback' },
  { url: 'https://octopus.energy/refer', company_name: 'Octopus Energy' },
  { url: 'https://www.puregym.com/refer', company_name: 'PureGym' },
  { url: 'https://www.trainline.com/refer', company_name: 'Trainline' },
  { url: 'https://www.coinbase.com/refer', company_name: 'Coinbase' },
  { url: 'https://www.binance.com/en-GB/referral', company_name: 'Binance' },
  { url: 'https://www.kraken.com/referral', company_name: 'Kraken' },
  { url: 'https://www.luno.com/en-gb/invite', company_name: 'Luno' },
]

interface ValidationResult {
  url: string
  company_name: string
  valid: boolean
  statusCode: number
  finalUrl: string
  contentHash: string | null
  error?: string
}

async function validate(): Promise<void> {
  logger.info({ count: SEED_URLS.length }, 'validating seed URLs')
  const results: ValidationResult[] = []

  for (const seed of SEED_URLS) {
    logger.info({ url: seed.url }, 'checking')

    try {
      const head = await headCheck(seed.url)

      if (head.statusCode === 200) {
        // Valid URL — fetch content and compute hash
        try {
          const { html } = await fetch(seed.url)
          const hash = computeContentHash(html)

          results.push({
            url: seed.url,
            company_name: seed.company_name,
            valid: true,
            statusCode: 200,
            finalUrl: head.finalUrl,
            contentHash: hash,
          })
          logger.info({ url: seed.url, hash }, 'valid')
        } catch (err) {
          results.push({
            url: seed.url,
            company_name: seed.company_name,
            valid: false,
            statusCode: head.statusCode,
            finalUrl: head.finalUrl,
            contentHash: null,
            error: 'fetch failed for content hash',
          })
          logger.warn({ url: seed.url, err }, 'head OK but fetch failed')
        }
      } else if (head.statusCode === 301 || head.statusCode === 302) {
        results.push({
          url: seed.url,
          company_name: seed.company_name,
          valid: true,
          statusCode: head.statusCode,
          finalUrl: head.finalUrl,
          contentHash: null,
        })
        logger.info({ url: seed.url, redirectedTo: head.finalUrl }, 'redirect — will follow at runtime')
      } else {
        results.push({
          url: seed.url,
          company_name: seed.company_name,
          valid: false,
          statusCode: head.statusCode,
          finalUrl: seed.url,
          contentHash: null,
          error: 'non-200 status',
        })
        logger.warn({ url: seed.url, statusCode: head.statusCode }, 'invalid')
      }
    } catch (err) {
      results.push({
        url: seed.url,
        company_name: seed.company_name,
        valid: false,
        statusCode: 0,
        finalUrl: seed.url,
        contentHash: null,
        error: String(err),
      })
      logger.warn({ url: seed.url, err }, 'validation failed')
    }

    // Rate limit between checks
    await new Promise(r => setTimeout(r, 1_000))
  }

  // Generate seed.sql
  const valid = results.filter(r => r.valid)
  const invalid = results.filter(r => !r.valid)

  let sql = '-- Validated seed URLs for monitored_pages\n'
  sql += '-- Generated by validate-seed.ts\n'
  sql += '-- Valid: ' + valid.length + ', Invalid: ' + invalid.length + '\n\n'

  for (const r of valid) {
    const hashLiteral = r.contentHash ? `'${r.contentHash}'` : 'NULL'
    const urlLiteral = `'${r.finalUrl.replace(/'/g, "''")}'`
    const nameLiteral = `'${r.company_name.replace(/'/g, "''")}'`
    sql += `INSERT INTO monitored_pages (url, company_name, last_content_hash) VALUES (${urlLiteral}, ${nameLiteral}, ${hashLiteral});\n`
  }

  const outputPath = join(__dirname, 'seed.sql')
  writeFileSync(outputPath, sql)
  logger.info({ path: outputPath, valid: valid.length, invalid: invalid.length }, 'seed.sql written')

  // Report invalid URLs
  if (invalid.length > 0) {
    logger.warn('Invalid URLs (require manual correction):')
    for (const r of invalid) {
      logger.warn({ url: r.url, statusCode: r.statusCode, error: r.error }, 'invalid seed URL')
    }
  }
}

validate()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'seed validation fatal')
    process.exit(1)
  })
