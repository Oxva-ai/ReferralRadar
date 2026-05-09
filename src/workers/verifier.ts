import got from 'got'
import { logger } from '../logger.js'
import { fetch } from '../services/fetcher.js'
import { extract } from '../services/extractor.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'
import { pool } from '../db/pool.js'

async function checkLinkHealth(url: string): Promise<'valid' | 'redirected' | 'broken' | 'timeout'> {
  try {
    const response = await got(url, {
      method: 'HEAD',
      timeout: { request: 10_000 },
      followRedirect: true,
      maxRedirects: 3,
      throwHttpErrors: false,
      http2: true,
    })
    if (response.statusCode === 200) return 'valid'
    if (response.statusCode >= 300 && response.statusCode < 400) return 'redirected'
    return 'broken'
  } catch {
    return 'timeout'
  }
}

interface StaleReferral {
  id: string
  source_url: string | null
  referral_link: string | null
  reward: string | null
  reward_numeric: number | null
  offer_text: string | null
  verification_failures: number
  last_verified_at: string | null
}

export async function run(): Promise<void> {
  const runId = await insertWorkerRun('verifier')
  let checked = 0
  let reExtracted = 0
  let deactivated = 0

  try {
    const result = await pool.query<StaleReferral>(`
      SELECT id, source_url, referral_link, reward, reward_numeric,
             offer_text, verification_failures, last_verified_at
      FROM referrals
      WHERE is_active = true AND source_url IS NOT NULL
        AND (last_verified_at IS NULL OR last_verified_at < NOW() - INTERVAL '7 days')
      ORDER BY last_verified_at ASC NULLS FIRST
      LIMIT 50
    `)

    logger.info({ count: result.rows.length }, 'verifier: stale referrals to check')

    for (const ref of result.rows) {
      checked++
      if (!ref.source_url) continue

      try {
        const { html, statusCode, url: finalUrl } = await fetch(ref.source_url)

        // Check referral link health
        if (ref.referral_link) {
          const linkHealth = await checkLinkHealth(ref.referral_link)
          if (linkHealth === 'broken' || linkHealth === 'timeout') {
            await pool.query(
              `UPDATE referrals SET notes = COALESCE(notes, '') || '; referral link ' || $1 || ' as of ' || NOW()::text,
             updated_at = NOW() WHERE id = $2`,
              [linkHealth, ref.id],
            )
            logger.info({ id: ref.id, url: ref.referral_link, status: linkHealth }, 'verifier: referral link unhealthy')
          }
        }

        if (statusCode === 404 || statusCode === 410) {
          await deactivatePage(ref)
          deactivated++
          continue
        }

        if (finalUrl !== ref.source_url) {
          await pool.query(
            'UPDATE referrals SET source_url = $1, updated_at = NOW() WHERE id = $2',
            [finalUrl, ref.id],
          )
        }

        const extracted = await extract(html, finalUrl)
        if (!extracted) {
          await pool.query(
            'UPDATE referrals SET last_verified_at = NOW(), updated_at = NOW() WHERE id = $1',
            [ref.id],
          )
          continue
        }

        if (extracted.reward && extracted.reward !== ref.reward) {
          await recordChange(ref, extracted, finalUrl)
          reExtracted++
        } else if (extracted.referralLink && extracted.referralLink !== ref.referral_link) {
          await pool.query(
            `UPDATE referrals SET referral_link = $1, last_verified_at = NOW(),
             verification_failures = 0, updated_at = NOW() WHERE id = $2`,
            [extracted.referralLink, ref.id],
          )
        } else {
          await pool.query(
            `UPDATE referrals SET last_verified_at = NOW(),
             verification_failures = 0, updated_at = NOW() WHERE id = $1`,
            [ref.id],
          )
        }
      } catch (err) {
        logger.warn({ err, id: ref.id, url: ref.source_url }, 'verifier: fetch failed')
        const failures = ref.verification_failures + 1
        await pool.query(
          `UPDATE referrals SET verification_failures = $1, last_verified_at = NOW(),
           updated_at = NOW(), notes = CASE WHEN $1 >= 3
           THEN COALESCE(notes, '') || '; needs manual review' ELSE notes END
           WHERE id = $2`,
          [failures, ref.id],
        )
      }
    }

    await completeWorkerRun(runId, checked, reExtracted)
    logger.info({ checked, reExtracted, deactivated }, 'verifier complete')
  } catch (err) {
    logger.error({ err }, 'verifier fatal error')
    await failWorkerRun(runId, String(err))
  }
}

async function deactivatePage(ref: StaleReferral): Promise<void> {
  await pool.query(
    `UPDATE referrals SET is_active = false, expires_at = NOW(),
     notes = COALESCE(notes, '') || '; page removed ' || NOW()::text,
     updated_at = NOW(), last_verified_at = NOW()
     WHERE id = $1`,
    [ref.id],
  )
  logger.info({ id: ref.id, url: ref.source_url }, 'verifier: page removed')
}

async function recordChange(ref: StaleReferral, extracted: Awaited<ReturnType<typeof extract>>, url: string): Promise<void> {
  if (!extracted) return

  await pool.query(
    `INSERT INTO offer_history
     (referral_id, old_offer_text, new_offer_text, old_reward, new_reward,
      old_reward_numeric, new_reward_numeric)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ref.id, ref.offer_text, extracted.offerText,
     ref.reward, extracted.reward,
     ref.reward_numeric, extracted.rewardNumeric],
  )

  await pool.query(
    `UPDATE referrals SET reward = $1, reward_numeric = $2, offer_text = $3,
     previous_offer = $4, previous_offer_numeric = $5,
     change_type = 'updated', updated_at = NOW(),
     last_verified_at = NOW(), verification_failures = 0
     WHERE id = $6`,
    [extracted.reward, extracted.rewardNumeric, extracted.offerText,
     ref.reward, ref.reward_numeric, ref.id],
  )

  logger.info({ id: ref.id, url, oldReward: ref.reward, newReward: extracted.reward }, 'verifier: reward changed')
}
