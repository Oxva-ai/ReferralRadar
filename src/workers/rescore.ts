import { logger } from '../logger.js'
import { pool } from '../db/pool.js'
import { insertWorkerRun, completeWorkerRun, failWorkerRun } from '../db/queries.js'

// Score materialisation: recalculate score for active referrals where drift > 0.05
// Runs every 15 minutes. Uses compute_score() with weights from app_config.
export async function runRescore(): Promise<void> {
  const runId = await insertWorkerRun('rescore')

  try {
    // Read all five weight values once, pass as parameters to compute_score
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
      `WITH updated AS (
         UPDATE referrals
         SET score = compute_score(
               reward_numeric, discovered_at, source_count,
               uk_signal_strength, engagement_score,
               $1::numeric, $2::numeric, $3::numeric, $4::numeric, $5::numeric
             ),
             updated_at = NOW()
         WHERE is_active = true
           AND ABS(score - compute_score(
                 reward_numeric, discovered_at, source_count,
                 uk_signal_strength, engagement_score,
                 $1::numeric, $2::numeric, $3::numeric, $4::numeric, $5::numeric
               )) > 0.05
         RETURNING id
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

// Engagement aggregation: recalculate clicks_last_7_days, impressions_last_7_days,
// and engagement_score for all active referrals. Runs every 15 minutes,
// offset from score materialisation.
export async function runEngagementAggregation(): Promise<void> {
  const runId = await insertWorkerRun('rescore-engage')

  try {
    const result = await pool.query<{ updated: number }>(
      `WITH updated AS (
         UPDATE referrals SET
           clicks_last_7_days = (
             SELECT COUNT(*) FROM click_events
             WHERE referral_id = referrals.id
               AND clicked_at > NOW() - INTERVAL '7 days'
           ),
           impressions_last_7_days = (
             SELECT COUNT(*) FROM impression_events
             WHERE referral_id = referrals.id
               AND impressed_at > NOW() - INTERVAL '7 days'
           ),
           engagement_score = LEAST(
             (
               SELECT COUNT(*) FROM click_events
               WHERE referral_id = referrals.id
                 AND clicked_at > NOW() - INTERVAL '7 days'
             ) / 10.0,
             1.0
           ) * CASE
             WHEN (SELECT COUNT(*) FROM impression_events
                   WHERE referral_id = referrals.id
                     AND impressed_at > NOW() - INTERVAL '7 days') > 0
               AND (SELECT COUNT(*) FROM click_events
                    WHERE referral_id = referrals.id
                      AND clicked_at > NOW() - INTERVAL '7 days') > 0
               AND (SELECT COUNT(*) FROM click_events
                    WHERE referral_id = referrals.id
                      AND clicked_at > NOW() - INTERVAL '7 days')::float
                  / (SELECT COUNT(*) FROM impression_events
                     WHERE referral_id = referrals.id
                       AND impressed_at > NOW() - INTERVAL '7 days') > 0.05 THEN 1.0
             WHEN (SELECT COUNT(*) FROM impression_events
                   WHERE referral_id = referrals.id
                     AND impressed_at > NOW() - INTERVAL '7 days') > 0
               AND (SELECT COUNT(*) FROM click_events
                    WHERE referral_id = referrals.id
                      AND clicked_at > NOW() - INTERVAL '7 days') > 0
               AND (SELECT COUNT(*) FROM click_events
                    WHERE referral_id = referrals.id
                      AND clicked_at > NOW() - INTERVAL '7 days')::float
                  / (SELECT COUNT(*) FROM impression_events
                     WHERE referral_id = referrals.id
                       AND impressed_at > NOW() - INTERVAL '7 days') > 0.01 THEN 0.7
             WHEN (SELECT COUNT(*) FROM impression_events
                   WHERE referral_id = referrals.id
                     AND impressed_at > NOW() - INTERVAL '7 days') > 0
               AND (SELECT COUNT(*) FROM click_events
                    WHERE referral_id = referrals.id
                      AND clicked_at > NOW() - INTERVAL '7 days') > 0 THEN 0.3
             ELSE 0.0
           END
         WHERE is_active = true
         RETURNING id
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
