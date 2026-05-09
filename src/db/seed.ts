import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'
import { logger } from '../logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function seed() {
  const client = await pool.connect()
  try {
    const sqlPath = join(__dirname, 'seed.sql')
    const sql = readFileSync(sqlPath, 'utf-8')

    if (!sql.trim()) {
      logger.info('seed.sql is empty, nothing to seed')
      return
    }

    logger.info('running seed')
    await client.query(sql)
    logger.info('seed complete')
  } catch (err) {
    logger.error({ err }, 'seed failed')
    throw err
  } finally {
    client.release()
  }
}

seed()
  .then(() => process.exit(0))
  .catch(() => process.exit(1))
