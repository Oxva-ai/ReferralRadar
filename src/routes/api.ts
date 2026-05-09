import { Router, type Request, type Response } from 'express'
import { logger } from '../logger.js'
import { config } from '../config.js'
import { referralsQuerySchema, idParamSchema, submissionSchema } from './validation.js'
import {
  queryReferrals,
  getReferralById,
  insertClickEvent,
  insertImpressionEvent,
  getHealthStats,
  type ReferralRow,
} from '../db/queries.js'
import { queue, enqueueJobToDb } from '../services/queue.js'
import { pool } from '../db/pool.js'
import { getDegradedFeeds } from '../workers/rss.js'
import { BRAND_BY_DOMAIN } from '../lib/brands.js'
import { getAllQuotaUsage } from '../services/quota-tracker.js'

const router = Router()

router.use((_req: Request, res: Response, next) => {
  res.setHeader('X-API-Version', '1.0.0')
  res.setHeader('X-Deprecated', 'false')
  next()
})

function setCacheHeaders(res: Response, maxAgeSeconds: number = 60): void {
  res.setHeader('Cache-Control', `public, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`)
}

// IMPORTANT: Static routes before parameterized routes

router.get('/health', async (_req: Request, res: Response) => {
  try {
    const health = await getHealthStats()
    const quotas = await getAllQuotaUsage()
    const degradedFeeds = getDegradedFeeds()

    res.json({
      status: degradedFeeds.length > 0 ? 'degraded' : 'ok',
      uptime_seconds: process.uptime(),
      db: 'connected',
      queries_today: quotas,
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
    logger.warn({ err }, 'health check db connection failed, returning degraded')
    res.json({
      status: 'degraded',
      uptime_seconds: process.uptime(),
      db: 'disconnected',
      version: '1.0.0',
    })
  }
})

router.get('/stats', async (_req: Request, res: Response) => {
  try {
    const health = await getHealthStats()
    const quotas = await getAllQuotaUsage()

    setCacheHeaders(res, 120)
    res.json({
      total_active: health.totalActive,
      discovered_today: health.discoveredToday,
      serper_quota: quotas.serper,
      brave_quota: quotas.brave,
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
    setCacheHeaders(res, 120)
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
    setCacheHeaders(res, 120)
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
    setCacheHeaders(res, 120)
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

// Category mapping — maps our categories to EasyEarns-readable labels
router.get('/referrals/categories', async (_req: Request, res: Response) => {
  try {
    const result = await pool.query<{ category: string; count: number }>(
      `SELECT COALESCE(category, 'uncategorised') AS category, COUNT(*)::int AS count
       FROM referrals WHERE is_active = true
       GROUP BY category ORDER BY count DESC`,
    )
    setCacheHeaders(res, 120)
    res.json({ data: result.rows })
    return
  } catch (err) {
    logger.error({ err }, 'categories query failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

// EasyEarns sync endpoint: batch poll for incremental data
router.get('/referrals/easyearns', async (req: Request, res: Response) => {
  const parsed = referralsQuerySchema.safeParse({
    ...req.query,
    limit: parseInt(String(req.query.limit)) || 200,
    sort: req.query.sort || 'newest',
  })
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
    setCacheHeaders(res, 60)
    res.json({
      data: result.data.map(formatReferral),
      meta: {
        total: result.total,
        limit: parsed.data.limit,
        offset: parsed.data.offset,
        since: parsed.data.since,
        has_more: parsed.data.offset + parsed.data.limit < result.total,
      },
    })
    return
  } catch (err) {
    logger.error({ err }, 'easyearns sync query failed')
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
    setCacheHeaders(res, 300)
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

    const recorded = await insertClickEvent(parsed.data.id)
    res.json({ status: 'ok', id: parsed.data.id, recorded })
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

    const recorded = await insertImpressionEvent(parsed.data.id)
    res.json({ status: 'ok', id: parsed.data.id, recorded })
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

  // DB-backed rate limit check
  const rateResult = await pool.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM submissions WHERE submitted_by = $1 AND created_at > NOW() - INTERVAL '1 hour'",
    [parsed.data.submitted_by],
  )
  if (rateResult.rows[0]!.count >= 20) {
    res.setHeader('Retry-After', '3600')
    res.status(429).json({ error: 'rate_limited', retry_after_seconds: 3600 })
    return
  }

  try {
    const { findReferralBySourceUrl } = await import('../db/queries.js')
    const existing = await findReferralBySourceUrl(parsed.data.url)
    if (existing) {
      res.status(409).json({ error: 'duplicate', existing_id: existing.id })
      return
    }

    const subResult = await pool.query<{ id: string }>(
      'INSERT INTO submissions (url, submitted_by) VALUES ($1, $2) RETURNING id',
      [parsed.data.url, parsed.data.submitted_by],
    )
    const submissionId = subResult.rows[0]!.id

    await enqueueJobToDb(parsed.data.url, 'user_submission', 'high', 'unknown', null, null, null, submissionId)

    res.status(201).json({ status: 'queued' })
    return
  } catch (err) {
    logger.error({ err }, 'submission failed')
    res.status(500).json({ error: 'internal_server_error' })
    return
  }
})

function formatReferral(row: ReferralRow) {
  const domain = row.domain ?? ''

  let brand: string | null = null
  if (row.company_name && row.company_name.length > 1) {
    brand = row.company_name
  }
  if (!brand && domain) {
    const lookup = BRAND_BY_DOMAIN[domain] ?? BRAND_BY_DOMAIN[`www.${domain}`]
    if (lookup) brand = lookup.name
  }
  if (!brand && domain) {
    const base = domain.replace(/^www\./, '').split('.')[0] ?? ''
    brand = base.charAt(0).toUpperCase() + base.slice(1)
  }

  let category: string | null = row.category ?? null
  if (!category && domain) {
    const lookup = BRAND_BY_DOMAIN[domain] ?? BRAND_BY_DOMAIN[`www.${domain}`]
    if (lookup) category = lookup.category ?? null
  }

  return {
    id: row.id,
    source_url: row.source_url,
    domain,
    company_name: row.company_name,
    brand,
    category,
    referral_link: row.referral_link,
    offer_text: row.offer_text,
    reward: row.reward,
    reward_numeric: row.reward_numeric,
    currency: row.currency,
    friend_reward: row.friend_reward,
    reward_type: row.reward_type,
    score: row.score,
    engagement_score: row.engagement_score,
    change_type: row.change_type,
    sources: row.sources,
    source_count: row.source_count,
    uk_signal_strength: row.uk_signal_strength,
    discovered_at: row.discovered_at,
    last_verified_at: row.last_verified_at,
    is_active: row.is_active,
    has_link: !!row.referral_link,
    referee_reward: row.referee_reward,
    referrer_reward: row.referrer_reward,
    offer_summary: row.offer_summary,
    referral_code: row.referral_code,
    terms_url: row.terms_url,
    is_instant: row.is_instant,
    is_no_id: row.is_no_id,
    is_gambling: row.is_gambling,
    requires_spending: row.requires_spending,
    confidence: row.confidence,
    logo_url: domain ? `https://img.logo.dev/${domain}?token=${config.LOGO_DEV_TOKEN}&size=128&format=png&fallback=404` : null,
  }
}

export default router
