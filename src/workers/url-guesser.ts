import { logger } from '../logger.js'
import { headCheck } from '../services/fetcher.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'
import { pool } from '../db/pool.js'

const COMMON_PATHS = [
  '/referral', '/refer-a-friend', '/refer', '/invite',
  '/invite-friends', '/earn', '/rewards', '/friends',
  '/tell-a-friend', '/recommend', '/raf',
]

interface CandidateDomain {
  id: string
  candidate_domain: string
}

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('url-guesser')
  let probed = 0
  let found = 0

  try {
    const result = await pool.query<CandidateDomain>(`
      SELECT id, candidate_domain FROM referrals
      WHERE source_url IS NULL AND candidate_domain IS NOT NULL
        AND created_at > NOW() - INTERVAL '24 hours'
    `)

    const candidates = result.rows
    logger.info({ count: candidates.length }, 'url-guesser: candidate domains')

    for (const candidate of candidates) {
      const domain = candidate.candidate_domain
      if (!domain) continue

      for (const path of COMMON_PATHS) {
        const testUrl = `https://${domain}${path}`
        probed++

        try {
          const { statusCode, finalUrl } = await headCheck(testUrl)

          if (statusCode === 200) {
            await pool.query(
              `UPDATE referrals SET source_url = $1, updated_at = NOW(),
               last_verified_at = NOW() WHERE id = $2`,
              [finalUrl, candidate.id],
            )
            logger.info({ id: candidate.id, domain, url: finalUrl }, 'url-guesser: found referral page')
            found++
            break
          }

          if (statusCode === 301 || statusCode === 302) {
            await pool.query(
              `UPDATE referrals SET source_url = $1, updated_at = NOW(),
               last_verified_at = NOW() WHERE id = $2`,
              [finalUrl, candidate.id],
            )
            logger.info({ id: candidate.id, domain, url: finalUrl }, 'url-guesser: found via redirect')
            found++
            break
          }
        } catch {
          logger.debug({ domain, path }, 'url-guesser: probe failed')
        }

        // Rate limit between probes
        await new Promise(r => setTimeout(r, 500))
      }
    }

    await completeWorkerRun(runId, probed, found)
    logger.info({ probed, found }, 'url-guesser complete')
  } catch (err) {
    logger.error({ err }, 'url-guesser fatal error')
    await failWorkerRun(runId, String(err))
  }
}
