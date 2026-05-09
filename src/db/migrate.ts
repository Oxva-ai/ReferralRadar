import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pool } from './pool.js'
import { logger } from '../logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export async function migrate(): Promise<void> {
  const client = await pool.connect()
  try {
    const schemaPath = join(__dirname, 'schema.sql')
    const sql = readFileSync(schemaPath, 'utf-8')

    logger.info('running database migration')
    await client.query(sql)
    logger.info('database migration complete')
  } catch (err) {
    logger.error({ err }, 'migration failed')
    throw err
  } finally {
    client.release()
  }
}

// Run directly
migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1))
