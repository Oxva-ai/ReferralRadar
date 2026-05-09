import type { Server } from 'node:http'
import { createApp } from './app.js'
import { config } from './config.js'
import { logger } from './logger.js'
import { pool } from './db/pool.js'
import * as scheduler from './workers/scheduler.js'
import { run as searchWorker } from './workers/search.js'
import { run as redditWorker, runTertiary as redditTertiaryWorker } from './workers/reddit.js'
import { run as brandSearchWorker } from './workers/brand-search.js'
import { run as competitorWorker } from './workers/competitor.js'
import { run as rssWorker, runSecondary as rssSecondaryWorker, runTertiary as rssTertiaryWorker } from './workers/rss.js'
import { run as pageMonitorWorker } from './workers/page-monitor.js'
import { getStuckSubmissions } from './db/queries.js'
import { queue } from './services/queue.js'
import { runRescore, runEngagementAggregation } from './workers/rescore.js'
import { run as verifierWorker } from './workers/verifier.js'
import { run as urlGuesserWorker } from './workers/url-guesser.js'

let server: Server

async function recoverStuckSubmissions() {
  try {
    const stuck = await getStuckSubmissions()
    for (const sub of stuck) {
      queue.enqueue({
        url: sub.url,
        source: 'user_submission',
        meta: { submission_id: sub.id },
      }, 'high')
      logger.info({ id: sub.id, url: sub.url }, 'recovered stuck submission')
    }
    if (stuck.length > 0) {
      logger.info({ count: stuck.length }, 'stuck submission recovery complete')
    }
  } catch (err) {
    logger.error({ err }, 'stuck submission recovery failed')
  }
}

async function main() {
  const app = createApp()
  await recoverStuckSubmissions()
  server = app.listen(config.PORT, () => {
    logger.info({ port: config.PORT, env: config.NODE_ENV }, 'server started')
  })

  // Phase 1: Google CSE
  scheduler.schedule('*/8 * * * *', 'search', searchWorker)

  // Brand-targeted search (every 6 hours)
  scheduler.schedule('0 */6 * * *', 'brand-search', brandSearchWorker)

  // Phase 2: Reddit (primary)
  scheduler.schedule('*/15 * * * *', 'reddit', redditWorker)
  // Reddit tertiary (once per hour)
  scheduler.schedule('0 * * * *', 'reddit-tertiary', redditTertiaryWorker)

  // Phase 2: Competitor sources (every 30 min)
  scheduler.schedule('*/30 * * * *', 'competitor', competitorWorker)

  // Phase 2: RSS feeds by tier
  scheduler.schedule('*/30 * * * *', 'rss-primary', rssWorker)
  scheduler.schedule('0 * * * *', 'rss-secondary', rssSecondaryWorker)
  scheduler.schedule('0 */2 * * *', 'rss-tertiary', rssTertiaryWorker)

  // Phase 3: Page monitor (every 4 hours)
  scheduler.schedule('0 */4 * * *', 'page-monitor', pageMonitorWorker)

  // Phase 3: Score materialisation (every 15 min)
  scheduler.schedule('*/15 * * * *', 'rescore', runRescore)

  // Phase 3: Engagement aggregation (every 15 min, offset from rescore)
  scheduler.schedule('*/15 * * * *', 'rescore-engage', runEngagementAggregation)

  // Phase 4: Verifier (stale referral re-check, every 3 hours)
  scheduler.schedule('0 */3 * * *', 'verifier', verifierWorker)

  // Phase 4: URL guesser (new domain probing, daily at 01:00 UTC)
  scheduler.schedule('0 1 * * *', 'url-guesser', urlGuesserWorker)

  // Daily maintenance
  scheduler.schedule('0 0 * * *', 'reset-quotas', resetDailyQuotas)
  scheduler.schedule('0 */6 * * *', 'purge-expired', purgeExpired)
  scheduler.schedule('0 3 * * *', 'gdpr-cleanup', gdprRetentionCleanup)

  scheduler.start()
  logger.info('all workers scheduled')
}

async function resetDailyQuotas() {
  await pool.query('DELETE FROM api_usage WHERE date < CURRENT_DATE')
}

async function purgeExpired() {
  await pool.query(`
    UPDATE referrals SET is_active = false
    WHERE is_active = true
      AND discovered_at < NOW() - INTERVAL '30 days'
      AND engagement_score = 0
      AND (last_verified_at IS NULL OR last_verified_at < NOW() - INTERVAL '7 days')
  `)
  await pool.query("DELETE FROM click_events WHERE clicked_at < NOW() - INTERVAL '30 days'")
  await pool.query("DELETE FROM impression_events WHERE impressed_at < NOW() - INTERVAL '30 days'")
  await pool.query('SELECT trim_worker_runs()')
  await pool.query(`DELETE FROM submissions WHERE created_at < NOW() - INTERVAL '7 days' AND status = 'pending'`)
  await pool.query("DELETE FROM reddit_processed_posts WHERE processed_at < NOW() - INTERVAL '48 hours'")
}

async function gdprRetentionCleanup() {
  const referralDays = config.REFERRAL_RETENTION_DAYS
  const eventDays = config.EVENT_RETENTION_DAYS

  await pool.query(
    `UPDATE referrals SET is_active = false
     WHERE is_active = true
       AND discovered_at < NOW() - INTERVAL '1 day' * $1`,
    [referralDays],
  )

  await pool.query(
    `DELETE FROM click_events WHERE clicked_at < NOW() - INTERVAL '1 day' * $1`,
    [eventDays],
  )
  await pool.query(
    `DELETE FROM impression_events WHERE impressed_at < NOW() - INTERVAL '1 day' * $1`,
    [eventDays],
  )

  await pool.query(
    "DELETE FROM worker_runs WHERE started_at < NOW() - INTERVAL '30 days'",
  )

  await pool.query(
    "DELETE FROM dead_letter_queue WHERE failed_at < NOW() - INTERVAL '30 days'",
  )

  await pool.query(
    "DELETE FROM webhook_deliveries WHERE attempted_at < NOW() - INTERVAL '30 days'",
  )

  await pool.query(
    "DELETE FROM search_queries WHERE executed_at < NOW() - INTERVAL '30 days'",
  )

  await pool.query(
    "DELETE FROM submissions WHERE created_at < NOW() - INTERVAL '30 days' AND status IN ('processed', 'rejected')",
  )

  logger.info({ referralDays, eventDays }, 'GDPR retention cleanup complete')
}

function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down')
  scheduler.stop()
  server.close(() => {
    pool.end()
    logger.info('shutdown complete')
    process.exit(0)
  })
  setTimeout(() => {
    logger.error('forced shutdown after timeout')
    process.exit(1)
  }, 25_000)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (err) => {
  logger.error({ err }, 'unhandled rejection')
})

main()
