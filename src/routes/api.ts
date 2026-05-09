import { Router, type Request, type Response } from 'express'
import { logger } from '../logger.js'
import { referralsQuerySchema, idParamSchema, submissionSchema } from './validation.js'
import {
  queryReferrals,
  getReferralById,
  insertClickEvent,
  insertImpressionEvent,
  getCseQuotaUsed,
  getHealthStats,
  type ReferralRow,
} from '../db/queries.js'
import { queue } from '../services/queue.js'
import { pool } from '../db/pool.js'
import { getDegradedFeeds } from '../workers/rss.js'

const router = Router()

// In-memory user submission rate limit: 20 requests per hour per user
const submissionRateLimit = new Map<string, { count: number; resetAt: number }>()
const SUBMISSIONS_PER_HOUR = 20
const SUBMISSION_WINDOW_MS = 60 * 60 * 1000

// IMPORTANT: Static routes before parameterized routes

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const health = await getHealthStats()
    const cseUsed = await getCseQuotaUsed()
    const degradedFeeds = getDegradedFeeds()

    res.json({
      status: degradedFeeds.length > 0 ? 'degraded' : 'ok',
      uptime_seconds: process.uptime(),
      db: 'connected',
      queries_today: {
        google_cse: { used: cseUsed, limit: 100 },
      },
      workers: health.workerRuns.reduce((acc: Record<string, unknown>, r: Record<string, unknown>) => {
        acc[r.worker_name as string] = {
          last_run: r.started_at,
          last_status: r.status,
        }
        return acc
      }, {}),
      queue: { pending: queue.size, processing: queue.active },
      rss: { degraded_feeds: degradedFeeds },
      total_active: health.totalActive,
      discovered_today: health.discoveredToday,
      version: '1.0.0',
    })
  } catch (err) {
    logger.error({ err }, 'health check failed')
    res.status(503).json({ status: 'error', error: 'database connection failed' })
  }
})

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const health = await getHealthStats()
    const cseUsed = await getCseQuotaUsed()

    res.json({
      total_active: health.totalActive,
      discovered_today: health.discoveredToday,
      cse_queries_used: cseUsed,
      cse_queries_limit: 100,
      queue_pending: queue.size,
      queue_active: queue.active,
    })
    return
  } catch (err) {
    logger.error({ err }, 'stats failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

router.get('/top', async (req: Request, res: Response) => {
  try {
    const result = await queryReferrals({
      limit: 20,
      sort: 'score',
      min_score: 0.3,
    })
    res.json({
      data: result.data.map(formatReferral),
      meta: { total: result.total, limit: 20 },
    })
    return
  } catch (err) {
    logger.error({ err }, 'top referrals query failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

router.get('/referrals', async (req: Request, res: Response) => {
  const parsed = referralsQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_failed',
      fields: Object.fromEntries(
        parsed.error.issues.map(i => [i.path.join('.'), i.message]),
      ),
    })
    return
  }

  try {
    const result = await queryReferrals(parsed.data)
    res.json({
      data: result.data.map(formatReferral),
      meta: {
        total: result.total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        min_score: parsed.data.min_score,
        since: parsed.data.since,
      },
    })
    return
  } catch (err) {
    logger.error({ err }, 'referrals query failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

router.get('/referrals/changed', async (req: Request, res: Response) => {
  const parsed = referralsQuerySchema.safeParse({ ...req.query, change_type: 'updated', sort: 'newest' })
  if (!parsed.success) {
    res.status(400).json({
      error: 'validation_failed',
      fields: Object.fromEntries(
        parsed.error.issues.map(i => [i.path.join('.'), i.message]),
      ),
    })
    return
  }

  try {
    const result = await queryReferrals(parsed.data)
    res.json({
      data: result.data.map(formatReferral),
      meta: { total: result.total, limit: parsed.data.limit, offset: parsed.data.offset },
    })
    return
  } catch (err) {
    logger.error({ err }, 'changed referrals query failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

// Parameterized route — MUST be after all static routes
router.get('/referrals/:id', async (req: Request, res: Response) => {
  const parsed = idParamSchema.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_id' })
    return
  }

  try {
    const referral = await getReferralById(parsed.data.id)
    if (!referral) {
      res.status(404).json({ error: 'not_found' })
      return
    }
    res.json({ data: formatReferral(referral) })
    return
  } catch (err) {
    logger.error({ err }, 'referral get failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

router.post('/referrals/:id/click', async (req: Request, res: Response) => {
  const parsed = idParamSchema.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_id' })
    return
  }

  try {
    const referral = await getReferralById(parsed.data.id)
    if (!referral) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    await insertClickEvent(parsed.data.id)
    res.json({ status: 'ok', id: parsed.data.id })
    return
  } catch (err) {
    logger.error({ err }, 'click record failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

router.post('/referrals/:id/impression', async (req: Request, res: Response) => {
  const parsed = idParamSchema.safeParse(req.params)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_id' })
    return
  }

  try {
    const referral = await getReferralById(parsed.data.id)
    if (!referral) {
      res.status(404).json({ error: 'not_found' })
      return
    }

    await insertImpressionEvent(parsed.data.id)
    res.json({ status: 'ok', id: parsed.data.id })
    return
  } catch (err) {
    logger.error({ err }, 'impression record failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

router.post('/submissions', async (req: Request, res: Response) => {
  const parsed = submissionSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(422).json({
      error: 'validation_failed',
      fields: Object.fromEntries(
        parsed.error.issues.map(i => [i.path.join('.'), i.message]),
      ),
    })
    return
  }

  // In-memory rate limit check
  const userId = parsed.data.submitted_by
  const now = Date.now()
  const rateEntry = submissionRateLimit.get(userId)

  if (rateEntry) {
    if (now >= rateEntry.resetAt) {
      submissionRateLimit.delete(userId)
    } else if (rateEntry.count >= SUBMISSIONS_PER_HOUR) {
      const retryAfterSeconds = Math.ceil((rateEntry.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfterSeconds))
      res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfterSeconds })
      return
    }
  }

  const current = submissionRateLimit.get(userId) ?? { count: 0, resetAt: now + SUBMISSION_WINDOW_MS }
  current.count++
  submissionRateLimit.set(userId, current)

  try {
    const { findReferralBySourceUrl } = await import('../db/queries.js')
    const existing = await findReferralBySourceUrl(parsed.data.url)
    if (existing) {
      res.status(409).json({ error: 'duplicate', existing_id: existing.id })
      return
    }

    await pool.query(
      'INSERT INTO submissions (url, submitted_by) VALUES ($1, $2)',
      [parsed.data.url, parsed.data.submitted_by],
    )

    queue.enqueue({
      url: parsed.data.url,
      source: 'user_submission',
      meta: {},
    }, 'high')

    res.status(201).json({ status: 'queued' })
    return
  } catch (err) {
    logger.error({ err }, 'submission failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

function formatReferral(row: ReferralRow) {
  return {
    id: row.id,
    source_url: row.source_url,
    domain: row.domain,
    referral_link: row.referral_link,
    company_name: row.company_name,
    offer_text: row.offer_text,
    reward: row.reward,
    reward_numeric: row.reward_numeric,
    currency: row.currency,
    friend_reward: row.friend_reward,
    reward_type: row.reward_type,
    change_type: row.change_type,
    score: row.score,
    engagement_score: row.engagement_score,
    sources: row.sources,
    source_count: row.source_count,
    discovered_at: row.discovered_at,
    last_verified_at: row.last_verified_at,
  }
}

export default router
