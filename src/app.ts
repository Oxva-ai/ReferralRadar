import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { timingSafeEqual } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { pool } from './db/pool.js'
import { correlation } from './correlation.js'
import apiRoutes from './routes/api.js'
import adminRoutes from './routes/admin.js'
import adminApiRoutes from './routes/admin-api.js'

declare global {
  namespace Express {
    interface Request {
      isAdmin?: boolean
    }
  }
}

export function createApp(): express.Express {
  const app = express()

  app.use(express.json({ limit: '1kb' }))

  app.use(cors({
    origin: config.NODE_ENV === 'production'
      ? [...config.CORS_ORIGINS.split(','), ...(config.EASYEARNS_STAGING_ORIGINS ? config.EASYEARNS_STAGING_ORIGINS.split(',') : [])].filter(Boolean)
      : '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-ID'],
    maxAge: 86400,
  }))

  const limiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const key = req.headers.authorization?.replace('Bearer ', '')
      return key ?? req.ip ?? 'unknown'
    },
  })
  app.use('/api/v1', limiter)

  app.use((req, _res, next) => {
    const requestId = req.headers['x-request-id'] as string ?? randomUUID()
    correlation.run(requestId, next)
  })

  app.use('/api/v1', async (req, res, next) => {
    if (req.path === '/health') return next()
    const key = req.headers.authorization?.replace('Bearer ', '') ?? ''
    if (!key) {
      return res.status(401).json({ error: 'unauthorized' })
    }

    const keyBuf = Buffer.from(key)
    const easyearnsBuf = Buffer.from(config.EASYEARNS_API_KEY)
    const adminBuf = Buffer.from(config.ADMIN_API_KEY)

    if (keyBuf.length !== easyearnsBuf.length && keyBuf.length !== adminBuf.length) {
      return res.status(401).json({ error: 'unauthorized' })
    }

    const isEasyearns = keyBuf.length === easyearnsBuf.length
      && timingSafeEqual(keyBuf, easyearnsBuf)
    const isAdmin = keyBuf.length === adminBuf.length
      && timingSafeEqual(keyBuf, adminBuf)

    if (!isEasyearns && !isAdmin) {
      try {
        const prevKeys = await pool.query<{ key: string; value: string }>(
          "SELECT key, value FROM app_config WHERE key IN ('easyearns_api_key_previous', 'admin_api_key_previous')",
        )
        const easyearnsPrev = prevKeys.rows.find(r => r.key === 'easyearns_api_key_previous')?.value
        const adminPrev = prevKeys.rows.find(r => r.key === 'admin_api_key_previous')?.value

        if (easyearnsPrev) {
          const eb = Buffer.from(easyearnsPrev)
          if (keyBuf.length === eb.length && timingSafeEqual(keyBuf, eb)) {
            req.isAdmin = false
            return next()
          }
        }
        if (adminPrev) {
          const ab = Buffer.from(adminPrev)
          if (keyBuf.length === ab.length && timingSafeEqual(keyBuf, ab)) {
            req.isAdmin = true
            return next()
          }
        }
      } catch {
        // DB not available, fall through to rejection
      }
      return res.status(401).json({ error: 'unauthorized' })
    }

    req.isAdmin = isAdmin
    next()
  })

  app.use('/api/v1', apiRoutes)
  app.use('/api/v1', adminRoutes)
  app.use('/api/v1', adminApiRoutes)

  return app
}
