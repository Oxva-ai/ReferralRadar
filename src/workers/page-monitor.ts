import { createHash } from 'node:crypto'
import * as cheerio from 'cheerio'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { checkUkMarket } from '../services/uk-filter.js'
import { storeReferral } from '../services/deduper.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'
import { pool } from '../db/pool.js'

interface MonitoredPage {
  id: string
  url: string
  company_name: string | null
  last_content_hash: string | null
  check_interval: string
  consecutive_failures: number
  change_count: number
  last_checked_at: string | null
}

function computePageHash(html: string): string {
  const $ = cheerio.load(html)
  $('script, style, nav, footer, header, noscript, iframe, svg').remove()

  const text = $('body').text()
  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'DATE') // ISO dates
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi, 'UUID') // UUIDs
    .replace(/[A-Za-z0-9+/=]{20,}/g, 'TOKEN') // base64 tokens
    .trim()
    .toLowerCase()

  return createHash('sha256').update(normalized).digest('hex')
}

async function adjustFrequency(id: string, changeCount: number, consecutiveFailures: number): Promise<void> {
  let newInterval: string | null = null

  if (consecutiveFailures >= 3) {
    newInterval = '24 hours'
  } else if (changeCount >= 3) {
    newInterval = '2 hours'
  }

  if (newInterval) {
    await pool.query(
      'UPDATE monitored_pages SET check_interval = $1::interval, updated_at = NOW() WHERE id = $2',
      [newInterval, id],
    )
    logger.info({ id, newInterval }, 'adjusted page monitor frequency')
  }
}

async function handlePageChange(page: MonitoredPage, html: string): Promise<number> {
  let discovered = 0
  const extracted = await extract(html, page.url)

  if (!extracted) {
    logger.debug({ url: page.url }, 'page monitor: extraction returned nothing')
    return 0
  }

  const ukCheck = checkUkMarket(page.url, extracted.offerText ?? '')
  if (!ukCheck.pass) {
    logger.debug({ url: page.url, reason: ukCheck.reason }, 'page monitor: failed UK filter')
    return 0
  }

  // Check if this referral already exists (Layer 1 dedup by source_url)
  const existingResult = await pool.query<{ id: string; reward: string | null; reward_numeric: number | null; offer_text: string | null }>(
    'SELECT id, reward, reward_numeric, offer_text FROM referrals WHERE source_url = $1 AND is_active = true',
    [page.url],
  )

  if (existingResult.rows.length > 0 && existingResult.rows[0]) {
    const existing = existingResult.rows[0]
    // Check if reward changed
    if (extracted.reward && extracted.reward !== existing.reward) {
      // Record offer change
      await pool.query(
        `INSERT INTO offer_history
         (referral_id, old_offer_text, new_offer_text, old_reward, new_reward, old_reward_numeric, new_reward_numeric)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [existing.id, existing.offer_text, extracted.offerText, existing.reward, extracted.reward, existing.reward_numeric, extracted.rewardNumeric],
      )

      // Update the referral
      await pool.query(
        `UPDATE referrals
         SET reward = $1, reward_numeric = $2, offer_text = $3, previous_offer = $4,
             previous_offer_numeric = $5, change_type = 'updated', updated_at = NOW(),
             last_verified_at = NOW()
         WHERE id = $6`,
        [extracted.reward, extracted.rewardNumeric, extracted.offerText, existing.reward, existing.reward_numeric, existing.id],
      )

      logger.info({ id: existing.id, url: page.url, oldReward: existing.reward, newReward: extracted.reward }, 'offer change detected')
      discovered++
    } else {
      // No change, just update verified timestamp
      await pool.query(
        'UPDATE referrals SET last_verified_at = NOW(), updated_at = NOW() WHERE id = $1',
        [existing.id],
      )
    }
  } else {
    // New referral from monitored page
    const id = await storeReferral(page.url, extracted, 'page_monitor', ukCheck.signal)
    if (id) discovered++
  }

  return discovered
}

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('page-monitor')
  let processed = 0
  let changesDetected = 0
  let pagesMarkedInactive = 0

  try {
    // Select all due pages — NO LIMIT, process all
    const result = await pool.query<MonitoredPage>(
      `SELECT id, url, company_name, last_content_hash, check_interval,
              consecutive_failures, change_count, last_checked_at
       FROM monitored_pages
       WHERE next_check_at <= NOW() AND is_active = true
       ORDER BY next_check_at ASC`,
    )

    const pages = result.rows
    logger.info({ due: pages.length }, 'page monitor: pages due for check')

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!
      processed++

      // Yield to event loop every 10 pages
      if (i > 0 && i % 10 === 0) {
        await new Promise(r => setTimeout(r, 0))
      }

      try {
        const { html, statusCode } = await fetch(page.url)

        // Handle non-200 responses
        if (statusCode === 404 || statusCode === 410) {
          logger.warn({ url: page.url, statusCode }, 'page monitor: page gone')
          // Mark page as inactive
          await pool.query(
            'UPDATE monitored_pages SET is_active = false, updated_at = NOW() WHERE id = $1',
            [page.id],
          )
          // Deactivate related referrals
          await pool.query(
            `UPDATE referrals SET is_active = false, notes = COALESCE(notes, '') || '; page removed ' || NOW()::text
             WHERE source_url = $1 AND is_active = true`,
            [page.url],
          )
          pagesMarkedInactive++
          continue
        }

        if (statusCode >= 500) {
          const failures = page.consecutive_failures + 1
          await pool.query(
            `UPDATE monitored_pages
             SET consecutive_failures = $1, next_check_at = NOW() + CASE WHEN $1 >= 3 THEN '24 hours'::interval ELSE check_interval END,
                 updated_at = NOW()
             WHERE id = $2`,
            [failures, page.id],
          )
          await adjustFrequency(page.id, page.change_count, failures)
          logger.warn({ url: page.url, statusCode, consecutiveFailures: failures }, 'page monitor: server error')
          continue
        }

        // Compute page content hash
        const newHash = computePageHash(html)

        // Update last_checked_at and reset failures
        await pool.query(
          `UPDATE monitored_pages
           SET last_checked_at = NOW(), consecutive_failures = 0,
               next_check_at = NOW() + check_interval, updated_at = NOW()
           WHERE id = $1`,
          [page.id],
        )

        // Compare with last hash
        if (page.last_content_hash && newHash === page.last_content_hash) {
          // No change — just update hash if missing
          logger.debug({ url: page.url }, 'page monitor: no change')
        } else {
          // Content changed
          logger.info({ url: page.url, id: page.id }, 'page monitor: change detected')

          const newHashChanged = newHash !== page.last_content_hash

          // Update hash and increment change count
          const changeCount = newHashChanged ? page.change_count + 1 : page.change_count

          await pool.query(
            `UPDATE monitored_pages
             SET last_content_hash = $1, change_count = $2,
                 check_interval = CASE
                   WHEN $2 >= 3 THEN '2 hours'::interval
                   ELSE check_interval
                 END,
                 updated_at = NOW()
             WHERE id = $3`,
            [newHash, changeCount, page.id],
          )

          if (newHashChanged) {
            const discovered = await handlePageChange(page, html)
            changesDetected += discovered
          }

          await adjustFrequency(page.id, changeCount, 0)
        }
      } catch (err) {
        logger.warn({ err, url: page.url }, 'page monitor: fetch/process failed')

        const failures = page.consecutive_failures + 1
        await pool.query(
          `UPDATE monitored_pages
           SET consecutive_failures = $1, next_check_at = NOW() + CASE WHEN $1 >= 3 THEN '24 hours'::interval ELSE check_interval END,
               updated_at = NOW()
           WHERE id = $2`,
          [failures, page.id],
        )
        await adjustFrequency(page.id, page.change_count, failures)
      }
    }

    await completeWorkerRun(runId, processed, changesDetected)
    logger.info({
      processed,
      changesDetected,
      pagesMarkedInactive,
    }, 'page monitor complete')
  } catch (err) {
    logger.error({ err }, 'page monitor fatal error')
    await failWorkerRun(runId, String(err))
  }
}
