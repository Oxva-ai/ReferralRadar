import { Pool } from 'pg'
import { config } from '../config.js'
import { logger } from '../logger.js'

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: config.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
})

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected pool error')
})
