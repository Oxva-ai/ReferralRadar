import { pool } from '../db/pool.js'
import { logger } from '../logger.js'

const SERPER_DAILY_LIMIT = 83
const BRAVE_DAILY_LIMIT = 66

export async function checkQuota(api: 'serper' | 'brave'): Promise<boolean> {
  const limit = api === 'serper' ? SERPER_DAILY_LIMIT : BRAVE_DAILY_LIMIT
  const result = await pool.query<{ queries_used: number }>(
    "SELECT queries_used FROM api_usage WHERE api_name = $1 AND date = CURRENT_DATE",
    [api],
  )
  const used = result.rows[0]?.queries_used ?? 0
  if (used >= limit) {
    logger.warn({ api, used, limit }, 'API quota exhausted for today')
    return false
  }
  return true
}

export async function incrementQuota(api: 'serper' | 'brave'): Promise<void> {
  await pool.query(
    `INSERT INTO api_usage (api_name, date, queries_used) VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (api_name, date) DO UPDATE SET queries_used = api_usage.queries_used + 1`,
    [api],
  )
}

export async function getQuotaUsage(api: 'serper' | 'brave'): Promise<{ used: number; limit: number }> {
  const limit = api === 'serper' ? SERPER_DAILY_LIMIT : BRAVE_DAILY_LIMIT
  const result = await pool.query<{ queries_used: number }>(
    "SELECT queries_used FROM api_usage WHERE api_name = $1 AND date = CURRENT_DATE",
    [api],
  )
  return { used: result.rows[0]?.queries_used ?? 0, limit }
}

export async function getAllQuotaUsage(): Promise<Record<string, { used: number; limit: number }>> {
  const [serper, brave] = await Promise.all([
    getQuotaUsage('serper'),
    getQuotaUsage('brave'),
  ])
  return {
    serper,
    brave,
    google_cse: { used: 0, limit: 100 },
  }
}
