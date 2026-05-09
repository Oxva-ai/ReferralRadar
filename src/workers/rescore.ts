import { logger } from '../logger.js'
import { pool } from '../db/pool.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'

export async function runRescore(): Promise<void> {
  const runId = await insertWorkerRun('rescore')

  try {
    const weightResult = await pool.query<{ key: string; value: string }>(
      "SELECT key, value FROM app_config WHERE key LIKE 'score_weight_%'",
    )

    const weights: Record<string, number> = {}
    for (const row of weightResult.rows) {
      weights[row.key] = parseFloat(row.value)
    }

    const wFresh = weights['score_weight_freshness'] ?? 0.25
    const wNovel = weights['score_weight_novelty'] ?? 0.20
    const wVal = weights['score_weight_value'] ?? 0.20
    const wUk = weights['score_weight_uk_signal'] ?? 0.10
    const wEngage = weights['score_weight_engagement'] ?? 0.25

    const result = await pool.query<{ updated: number }>(
      `WITH calculated AS (
         SELECT id, compute_score(
           reward_numeric, discovered_at, source_count,
           uk_signal_strength, engagement_score,
           $1::numeric, $2::numeric, $3::numeric, $4::numeric, $5::numeric
         ) AS new_score
         FROM referrals
         WHERE is_active = true
       ),
       updated AS (
         UPDATE referrals SET
           score = calculated.new_score,
           updated_at = NOW()
         FROM calculated
         WHERE referrals.id = calculated.id
           AND (referrals.score IS NULL OR ABS(referrals.score - calculated.new_score) > 0.005)
         RETURNING referrals.id
       )
       SELECT COUNT(*)::int AS updated FROM updated`,
      [wFresh, wNovel, wVal, wUk, wEngage],
    )

    const updated = result.rows[0]?.updated ?? 0
    await completeWorkerRun(runId, updated, 0)
    logger.info({ updated }, 'score materialisation complete')
  } catch (err) {
    logger.error({ err }, 'score materialisation fatal error')
    await failWorkerRun(runId, String(err))
  }
}

export async function runEngagementAggregation(): Promise<void> {
  const runId = await insertWorkerRun('rescore-engage')

  try {
    const result = await pool.query<{ updated: number }>(
      `WITH clicks AS (
         SELECT referral_id, COUNT(*) AS cnt
         FROM click_events
         WHERE clicked_at > NOW() - INTERVAL '7 days'
         GROUP BY referral_id
       ),
       impressions AS (
         SELECT referral_id, COUNT(*) AS cnt
         FROM impression_events
         WHERE impressed_at > NOW() - INTERVAL '7 days'
         GROUP BY referral_id
       ),
       updated AS (
         UPDATE referrals SET
           clicks_last_7_days = COALESCE(clicks.cnt, 0),
           impressions_last_7_days = COALESCE(impressions.cnt, 0),
           engagement_score = LEAST(
             COALESCE(clicks.cnt, 0) / 10.0,
             1.0
           ) * CASE
             WHEN COALESCE(impressions.cnt, 0) > 0
              AND COALESCE(clicks.cnt, 0) > 0
              AND COALESCE(clicks.cnt, 0)::float / NULLIF(COALESCE(impressions.cnt, 0), 0) > 0.05 THEN 1.0
             WHEN COALESCE(impressions.cnt, 0) > 0
              AND COALESCE(clicks.cnt, 0) > 0
              AND COALESCE(clicks.cnt, 0)::float / NULLIF(COALESCE(impressions.cnt, 0), 0) > 0.01 THEN 0.7
             WHEN COALESCE(impressions.cnt, 0) > 0
              AND COALESCE(clicks.cnt, 0) > 0 THEN 0.3
             ELSE 0.0
           END
         FROM clicks FULL JOIN impressions USING (referral_id)
         WHERE referrals.id = COALESCE(clicks.referral_id, impressions.referral_id)
           AND referrals.is_active = true
         RETURNING referrals.id
       )
       SELECT COUNT(*)::int AS updated FROM updated`,
    )

    const updated = result.rows[0]?.updated ?? 0
    await completeWorkerRun(runId, updated, 0)
    logger.info({ updated }, 'engagement aggregation complete')
  } catch (err) {
    logger.error({ err }, 'engagement aggregation fatal error')
    await failWorkerRun(runId, String(err))
  }
}
