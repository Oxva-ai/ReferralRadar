import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

let dbAvailable = false

export async function setup(): Promise<void> {
  const { Pool } = pg
  const dbUrl = process.env.DATABASE_URL || 'postgresql://referralradar:referralradar@localhost:5432/referralradar_test'

  const pool = new Pool({
    connectionString: dbUrl,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  })

  try {
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'db', 'schema.sql')
    const sql = readFileSync(schemaPath, 'utf-8')
    await pool.query(sql)
    dbAvailable = true
  } catch {
    dbAvailable = false
    process.env.INTEGRATION_TESTS_SKIP = 'true'
  } finally {
    await pool.end()
  }
}

export async function teardown(): Promise<void> {
  if (!dbAvailable) return

  const { Pool } = pg
  const dbUrl = process.env.DATABASE_URL || 'postgresql://referralradar:referralradar@localhost:5432/referralradar_test'

  const pool = new Pool({
    connectionString: dbUrl,
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  })

  try {
    await pool.query(`
      DROP TABLE IF EXISTS webhook_deliveries CASCADE;
      DROP TABLE IF EXISTS webhooks CASCADE;
      DROP TABLE IF EXISTS dead_letter_queue CASCADE;
      DROP TABLE IF EXISTS queue_jobs CASCADE;
      DROP TABLE IF EXISTS search_queries CASCADE;
      DROP TABLE IF EXISTS impression_events CASCADE;
      DROP TABLE IF EXISTS click_events CASCADE;
      DROP TABLE IF EXISTS offer_history CASCADE;
      DROP TABLE IF EXISTS blocked_domains CASCADE;
      DROP TABLE IF EXISTS reddit_processed_posts CASCADE;
      DROP TABLE IF EXISTS submissions CASCADE;
      DROP TABLE IF EXISTS monitored_pages CASCADE;
      DROP TABLE IF EXISTS worker_runs CASCADE;
      DROP TABLE IF EXISTS api_usage CASCADE;
      DROP TABLE IF EXISTS app_config CASCADE;
      DROP TABLE IF EXISTS brands CASCADE;
      DROP TABLE IF EXISTS referrals CASCADE;
    `)
  } finally {
    await pool.end()
  }
}
