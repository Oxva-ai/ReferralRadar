import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { pool } from '../db/pool.js'
import { logger } from '../logger.js'
import { getWebhooks, createWebhook, deleteWebhook, getDeliveryHistory } from '../services/webhook-service.js'
import { reloadBrands } from '../lib/brands.js'

const router = Router()

const uuidSchema = z.string().uuid()

const patchReferralSchema = z.object({
  company_name: z.string().optional(),
  reward: z.string().optional(),
  reward_numeric: z.number().optional(),
  category: z.string().optional(),
})

const batchCategorizeSchema = z.object({
  ids: z.array(z.string().uuid()),
  category: z.string(),
})

const blocklistAddSchema = z.object({
  domain: z.string().min(1),
})

const VALID_WORKERS: string[] = [
  'search', 'brand-search', 'reddit', 'reddit-tertiary',
  'competitor', 'rss-primary', 'rss-secondary', 'rss-tertiary',
  'page-monitor', 'verifier', 'url-guesser', 'rescore', 'rescore-engage',
]

let blockedDomainsTableReady = false

async function ensureBlockedDomainsTable(): Promise<void> {
  if (blockedDomainsTableReady) return
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocked_domains (
      domain TEXT PRIMARY KEY,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  blockedDomainsTableReady = true
}

router.get('/admin/blocklist', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    await ensureBlockedDomainsTable()
    const result = await pool.query<{ domain: string; added_at: string }>(
      'SELECT domain, added_at FROM blocked_domains ORDER BY added_at DESC',
    )
    return res.json({ domains: result.rows })
  } catch (err) {
    logger.error({ err }, 'failed to list blocked domains')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.post('/admin/blocklist/add', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const body = blocklistAddSchema.parse(req.body)
    await ensureBlockedDomainsTable()
    await pool.query(
      'INSERT INTO blocked_domains (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING',
      [body.domain],
    )
    return res.json({ status: 'ok' })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', details: err.errors })
    }
    logger.error({ err }, 'failed to add blocked domain')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.post('/admin/referrals/batch-categorize', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const body = batchCategorizeSchema.parse(req.body)

    if (body.ids.length === 0) {
      return res.json({ updated: 0 })
    }

    const placeholders = body.ids.map((_, i) => `$${i + 2}`).join(', ')
    const result = await pool.query(
      `UPDATE referrals SET category = $1, updated_at = NOW() WHERE id IN (${placeholders}) AND is_active = true`,
      [body.category, ...body.ids],
    )
    return res.json({ updated: result.rowCount ?? 0 })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', details: err.errors })
    }
    logger.error({ err }, 'failed to batch categorise referrals')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.delete('/admin/referrals/:id', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const { id } = z.object({ id: uuidSchema }).parse(req.params)
    await pool.query('UPDATE referrals SET is_active = false, updated_at = NOW() WHERE id = $1', [id])
    return res.json({ status: 'deleted' })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', details: err.errors })
    }
    logger.error({ err }, 'failed to delete referral')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.patch('/admin/referrals/:id', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const { id } = z.object({ id: uuidSchema }).parse(req.params)
    const body = patchReferralSchema.parse(req.body)

    const sets: string[] = []
    const values: unknown[] = []

    if (body.company_name !== undefined) {
      sets.push(`company_name = $${values.length + 2}`)
      values.push(body.company_name)
    }
    if (body.reward !== undefined) {
      sets.push(`reward = $${values.length + 2}`)
      values.push(body.reward)
    }
    if (body.reward_numeric !== undefined) {
      sets.push(`reward_numeric = $${values.length + 2}`)
      values.push(body.reward_numeric)
    }
    if (body.category !== undefined) {
      sets.push(`category = $${values.length + 2}`)
      values.push(body.category)
    }

    if (sets.length === 0) {
      return res.status(400).json({ error: 'no fields to update' })
    }

    sets.push('updated_at = NOW()')
    const result = await pool.query(
      `UPDATE referrals SET ${sets.join(', ')} WHERE id = $1 AND is_active = true RETURNING *`,
      [id, ...values],
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'referral not found' })
    }

    return res.json(result.rows[0])
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', details: err.errors })
    }
    logger.error({ err }, 'failed to update referral')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.get('/admin/referrals/:id', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const { id } = z.object({ id: uuidSchema }).parse(req.params)
    const result = await pool.query(
      'SELECT * FROM referrals WHERE id = $1',
      [id],
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'referral not found' })
    }

    return res.json(result.rows[0])
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: 'validation failed', details: err.errors })
    }
    logger.error({ err }, 'failed to fetch referral')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.post('/admin/workers/:workerName/restart', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const workerName = req.params.workerName as string
    if (!VALID_WORKERS.includes(workerName)) {
      return res.status(400).json({ error: `unknown worker: ${workerName}` })
    }

    const force = String(req.query.force) === 'true'

    const workerModules: Record<string, () => Promise<{ run: () => Promise<void> }>> = {
      search: () => import('../workers/search.js'),
      'brand-search': () => import('../workers/brand-search.js'),
      reddit: () => import('../workers/reddit.js'),
      'reddit-tertiary': () => import('../workers/reddit.js').then(m => ({ run: m.runTertiary })),
      competitor: () => import('../workers/competitor.js'),
      'rss-primary': () => import('../workers/rss.js'),
      'rss-secondary': () => import('../workers/rss.js').then(m => ({ run: m.runSecondary })),
      'rss-tertiary': () => import('../workers/rss.js').then(m => ({ run: m.runTertiary })),
      'page-monitor': () => import('../workers/page-monitor.js'),
      verifier: () => import('../workers/verifier.js'),
      'url-guesser': () => import('../workers/url-guesser.js'),
      rescore: () => import('../workers/rescore.js').then(m => ({ run: m.runRescore })),
      'rescore-engage': () => import('../workers/rescore.js').then(m => ({ run: m.runEngagementAggregation })),
    }

    const loader = workerModules[workerName]
    if (!loader) return res.status(400).json({ error: `unknown worker: ${workerName}` })
    const workerModule = await loader()
    setImmediate(() => {
      workerModule.run().catch((err: unknown) => {
        logger.error({ err, worker: workerName }, 'triggered worker failed')
      })
    })

    logger.info({ worker: workerName, force }, 'worker manually triggered via admin API')
    return res.json({ status: 'triggered', worker: workerName })
  } catch (err) {
    logger.error({ err }, 'failed to trigger worker')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.get('/admin/workers/:workerName', async (req: Request, res: Response) => {
  if (!req.isAdmin) {
    return res.status(401).json({ error: 'admin access required' })
  }

  try {
    const workerName = req.params.workerName
    const result = await pool.query<{
      id: string
      started_at: string
      finished_at: string | null
      status: string
      items_processed: number
      items_discovered: number
      error_message: string | null
    }>(
      `SELECT id, started_at, finished_at, status, items_processed, items_discovered, error_message
       FROM worker_runs
       WHERE worker_name = $1
       ORDER BY started_at DESC
       LIMIT 50`,
      [workerName],
    )
    return res.json({ runs: result.rows })
  } catch (err) {
    logger.error({ err }, 'failed to fetch worker runs')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.get('/admin/webhooks', async (req: Request, res: Response) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'admin access required' })
  try {
    const result = await pool.query(
      `SELECT id, url, events, secret IS NOT NULL as has_secret, is_active, created_at
       FROM webhooks ORDER BY created_at DESC`,
    )
    return res.json({ data: result.rows })
  } catch (err) {
    logger.error({ err }, 'failed to list webhooks')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.post('/admin/webhooks', async (req: Request, res: Response) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'admin access required' })
  try {
    const { url, events, secret } = req.body ?? {}
    if (!url || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: 'url and events (array) required' })
    }
    const id = await createWebhook(url, events, secret)
    return res.status(201).json({ status: 'created', id })
  } catch (err) {
    logger.error({ err }, 'failed to create webhook')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.delete('/admin/webhooks/:id', async (req: Request, res: Response) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'admin access required' })
  try {
    const id = req.params.id as string
    const deleted = await deleteWebhook(id)
    if (!deleted) return res.status(404).json({ error: 'not_found' })
    return res.json({ status: 'deleted' })
  } catch (err) {
    logger.error({ err }, 'failed to delete webhook')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.get('/admin/webhooks/:id/deliveries', async (req: Request, res: Response) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'admin access required' })
  try {
    const id = req.params.id as string
    const limit = parseInt(String(req.query.limit)) || 50
    const rows = await getDeliveryHistory(id, limit)
    return res.json({ data: rows })
  } catch (err) {
    logger.error({ err }, 'failed to list deliveries')
    return res.status(500).json({ error: 'internal server error' })
  }
})

router.post('/admin/brands/reload', async (req: Request, res: Response) => {
  if (!req.isAdmin) return res.status(401).json({ error: 'admin access required' })
  try {
    reloadBrands()
    return res.json({ status: 'reloaded' })
  } catch (err) {
    logger.error({ err }, 'failed to reload brands')
    return res.status(500).json({ error: 'internal server error' })
  }
})

export default router
