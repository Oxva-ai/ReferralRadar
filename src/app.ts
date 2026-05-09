import express from 'express'
import cors from 'cors'
import rateLimit from 'express-rate-limit'
import { timingSafeEqual } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { config } from './config.js'
import { logger } from './logger.js'
import { correlation } from './correlation.js'
import apiRoutes from './routes/api.js'
import adminRoutes from './routes/admin.js'

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
    origin: config.NODE_ENV === 'production' ? config.CORS_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
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

  app.use('/api/v1', (req, res, next) => {
    if (req.path === '/health') return next()
    const key = req.headers.authorization?.replace('Bearer ', '') ?? ''

    // timingSafeEqual requires equal-length buffers — pad shorter key
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
      return res.status(401).json({ error: 'unauthorized' })
    }

    req.isAdmin = isAdmin
    next()
  })

  app.use('/api/v1', apiRoutes)
  app.use('/api/v1', adminRoutes)

  return app
}
