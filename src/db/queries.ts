import { pool } from './pool.js'
import type { QueryResult } from 'pg'

export interface ReferralRow {
  id: string
  source_url: string | null
  domain: string | null
  candidate_domain: string | null
  referral_link: string | null
  company_name: string | null
  offer_text: string | null
  reward: string | null
  reward_numeric: number | null
  currency: string
  friend_reward: string | null
  friend_reward_numeric: number | null
  reward_type: 'per_referral' | 'dual' | 'capped' | 'free_product' | 'free_share' | 'switching_bonus' | 'percentage' | 'signup_credit' | 'image_text' | 'unknown'
  qualifying_spend: string | null
  max_referrals: number | null
  content_hash: string | null
  change_type: 'new' | 'updated'
  previous_offer: string | null
  previous_offer_numeric: number | null
  score: number | null
  engagement_score: number
  clicks_last_7_days: number
  impressions_last_7_days: number
  sources: string[]
  source_count: number
  uk_signal_strength: string
  reddit_post_id: string | null
  reddit_score: number | null
  reddit_comments: number | null
  discovered_at: Date
  last_verified_at: Date | null
  expires_at: Date | null
  is_active: boolean
  is_aggregator: boolean
  referee_reward: string | null
  referrer_reward: string | null
  offer_summary: string | null
  referral_code: string | null
  terms_url: string | null
  is_instant: boolean
  is_no_id: boolean
  is_gambling: boolean
  requires_spending: boolean
  confidence: number | null
  verification_failures: number
  notes: string | null
  created_at: Date
  updated_at: Date
  category: string | null
}

export interface InsertReferral {
  source_url?: string | null
  candidate_domain?: string | null
  referral_link?: string | null
  company_name?: string | null
  offer_text?: string | null
  reward?: string | null
  reward_numeric?: number | null
  currency?: string
  friend_reward?: string | null
  friend_reward_numeric?: number | null
  reward_type?: string
  qualifying_spend?: string | null
  max_referrals?: number | null
  content_hash?: string | null
  change_type?: string
  previous_offer?: string | null
  previous_offer_numeric?: number | null
  score?: number | null
  sources?: string[]
  source_count?: number
  uk_signal_strength?: string
  reddit_post_id?: string | null
  reddit_score?: number | null
  reddit_comments?: number | null
  is_active?: boolean
  is_aggregator?: boolean
  referee_reward?: string | null
  referrer_reward?: string | null
  offer_summary?: string | null
  referral_code?: string | null
  terms_url?: string | null
  is_instant?: boolean
  is_no_id?: boolean
  is_gambling?: boolean
  requires_spending?: boolean
  confidence?: number | null
  notes?: string | null
  category?: string | null
}

export async function insertReferral(data: InsertReferral): Promise<ReferralRow> {
  const result = await pool.query<ReferralRow>(`
    INSERT INTO referrals (
      source_url, candidate_domain, referral_link, company_name, offer_text,
      reward, reward_numeric, currency, friend_reward, friend_reward_numeric,
      reward_type, qualifying_spend, max_referrals, content_hash, change_type,
      previous_offer, previous_offer_numeric, score, sources, source_count,
      uk_signal_strength, reddit_post_id, reddit_score, reddit_comments,
      is_active, is_aggregator, referee_reward, referrer_reward, offer_summary,
      referral_code, terms_url, is_instant, is_no_id, is_gambling,
      requires_spending, confidence, notes, category
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20,
      $21, $22, $23, $24,
      $25, $26, $27, $28, $29,
      $30, $31, $32, $33, $34,
      $35, $36, $37, $38
    )
    RETURNING *
  `, [
    data.source_url ?? null,
    data.candidate_domain ?? null,
    data.referral_link ?? null,
    data.company_name ?? null,
    data.offer_text ?? null,
    data.reward ?? null,
    data.reward_numeric ?? null,
    data.currency ?? 'GBP',
    data.friend_reward ?? null,
    data.friend_reward_numeric ?? null,
    data.reward_type ?? 'unknown',
    data.qualifying_spend ?? null,
    data.max_referrals ?? null,
    data.content_hash ?? null,
    data.change_type ?? 'new',
    data.previous_offer ?? null,
    data.previous_offer_numeric ?? null,
    data.score ?? null,
    data.sources ?? [],
    data.source_count ?? 1,
    data.uk_signal_strength ?? 'unknown',
    data.reddit_post_id ?? null,
    data.reddit_score ?? null,
    data.reddit_comments ?? null,
    data.is_active ?? true,
    data.is_aggregator ?? false,
    data.referee_reward ?? null,
    data.referrer_reward ?? null,
    data.offer_summary ?? null,
    data.referral_code ?? null,
    data.terms_url ?? null,
    data.is_instant ?? false,
    data.is_no_id ?? false,
    data.is_gambling ?? false,
    data.requires_spending ?? false,
    data.confidence ?? null,
    data.notes ?? null,
    data.category ?? null,
  ])
  return result.rows[0]!
}

export async function findReferralBySourceUrl(url: string): Promise<ReferralRow | null> {
  const result = await pool.query<ReferralRow>(
    'SELECT * FROM referrals WHERE source_url = $1 AND is_active = true',
    [url],
  )
  return result.rows[0] ?? null
}

export async function findReferralByContentHash(hash: string): Promise<ReferralRow | null> {
  const result = await pool.query<ReferralRow>(
    'SELECT id, offer_text FROM referrals WHERE content_hash = $1 AND is_active = true',
    [hash],
  )
  return result.rows[0] ?? null
}

export async function findReferralByDomainAndCompany(domain: string, companyName: string): Promise<ReferralRow | null> {
  const result = await pool.query<ReferralRow>(
    `SELECT id, company_name FROM referrals
     WHERE domain = $1
       AND levenshtein(company_name, $2) < 3
       AND is_active = true`,
    [domain, companyName],
  )
  return result.rows[0] ?? null
}

export async function findInactiveReferralByContentHash(hash: string): Promise<ReferralRow | null> {
  const result = await pool.query<ReferralRow>(
    'SELECT * FROM referrals WHERE content_hash = $1 AND is_active = false LIMIT 1',
    [hash],
  )
  return result.rows[0] ?? null
}

export interface ReferralQueryParams {
  since?: string | undefined
  until?: string | undefined
  limit?: number | undefined
  offset?: number | undefined
  min_score?: number | undefined
  change_type?: string | undefined
  reward_type?: string | undefined
  min_value?: number | undefined
  has_link?: boolean | undefined
  sort?: string | undefined
}

export async function queryReferrals(params: ReferralQueryParams): Promise<{ data: ReferralRow[]; total: number }> {
  const conditions: string[] = [
    'r.is_active = true',
    // Final filter: must have a minimum score and either engagement or recent discovery
    `r.score >= COALESCE($${1}::numeric, (SELECT value::numeric FROM app_config WHERE key = 'score_min_threshold'))`,
    `(r.engagement_score > 0 OR r.discovered_at > NOW() - INTERVAL '30 days')`,
  ]
  const values: unknown[] = [params.min_score ?? null]
  let paramIndex = 2

  if (params.since) {
    conditions.push(`r.discovered_at >= $${paramIndex++}`)
    values.push(params.since)
  }
  if (params.until) {
    conditions.push(`r.discovered_at <= $${paramIndex++}`)
    values.push(params.until)
  }
  if (params.change_type) {
    conditions.push(`r.change_type = $${paramIndex++}`)
    values.push(params.change_type)
  }
  if (params.reward_type) {
    conditions.push(`r.reward_type = $${paramIndex++}`)
    values.push(params.reward_type)
  }
  if (params.min_value !== undefined) {
    conditions.push(`r.reward_numeric >= $${paramIndex++}`)
    values.push(params.min_value)
  }
  if (params.has_link) {
    conditions.push('r.referral_link IS NOT NULL')
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const limit = Math.min(params.limit ?? 50, 100)
  const offset = params.offset ?? 0

  let orderBy = 'r.score DESC NULLS LAST'
  if (params.sort === 'newest') orderBy = 'r.discovered_at DESC'
  else if (params.sort === 'value') orderBy = 'r.reward_numeric DESC NULLS LAST'

  const countResult = await pool.query<{ total: number }>(
    `SELECT COUNT(*)::int AS total FROM referrals r ${whereClause}`,
    values,
  )
  const total = countResult.rows[0]?.total ?? 0

  const dataResult = await pool.query<ReferralRow>(
    `SELECT r.* FROM referrals r ${whereClause} ORDER BY ${orderBy} LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
    [...values, limit, offset],
  )

  return { data: dataResult.rows, total }
}

export async function getReferralById(id: string): Promise<ReferralRow | null> {
  const result = await pool.query<ReferralRow>(
    'SELECT * FROM referrals WHERE id = $1 AND is_active = true',
    [id],
  )
  return result.rows[0] ?? null
}

export async function updateReferralScore(id: string, score: number): Promise<void> {
  await pool.query(
    'UPDATE referrals SET score = $1, updated_at = NOW() WHERE id = $2',
    [score, id],
  )
}

export async function insertClickEvent(referralId: string): Promise<boolean> {
  const exists = await pool.query(
    `SELECT 1 FROM click_events
     WHERE referral_id = $1 AND clicked_at > NOW() - INTERVAL '1 day'
     LIMIT 1`,
    [referralId],
  )
  if (exists.rows.length > 0) return false

  await pool.query(
    'INSERT INTO click_events (referral_id) VALUES ($1)',
    [referralId],
  )
  return true
}

export async function insertImpressionEvent(referralId: string): Promise<boolean> {
  const exists = await pool.query(
    `SELECT 1 FROM impression_events
     WHERE referral_id = $1 AND impressed_at > NOW() - INTERVAL '1 day'
     LIMIT 1`,
    [referralId],
  )
  if (exists.rows.length > 0) return false

  await pool.query(
    'INSERT INTO impression_events (referral_id) VALUES ($1)',
    [referralId],
  )
  return true
}

export async function insertWorkerRun(workerName: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "INSERT INTO worker_runs (worker_name, status) VALUES ($1, 'running') RETURNING id",
    [workerName],
  )
  return result.rows[0]!.id
}

export async function completeWorkerRun(id: string, itemsProcessed: number, itemsDiscovered: number): Promise<void> {
  await pool.query(
    "UPDATE worker_runs SET status = 'completed', finished_at = NOW(), items_processed = $1, items_discovered = $2 WHERE id = $3",
    [itemsProcessed, itemsDiscovered, id],
  )
}

export async function failWorkerRun(id: string, errorMessage: string): Promise<void> {
  await pool.query(
    "UPDATE worker_runs SET status = 'failed', finished_at = NOW(), error_message = $1 WHERE id = $2",
    [errorMessage, id],
  )
}

export async function updateSubmissionStatus(
  id: string,
  status: 'pending' | 'processing' | 'processed' | 'rejected',
  resultReferralId?: string | null,
  rejectionReason?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE submissions SET status = $1, processed_at = NOW(),
     result_referral_id = COALESCE($2, result_referral_id),
     rejection_reason = COALESCE($3, rejection_reason)
     WHERE id = $4`,
    [status, resultReferralId ?? null, rejectionReason ?? null, id],
  )
}

export async function getStuckSubmissions(ageMinutes: number = 5): Promise<Array<{ id: string; url: string; submitted_by: string | null }>> {
  const result = await pool.query<{ id: string; url: string; submitted_by: string | null }>(
    `SELECT id, url, submitted_by FROM submissions
     WHERE status = 'pending' AND created_at < NOW() - $1::interval
     ORDER BY created_at ASC
     LIMIT 50`,
    [`${ageMinutes} minutes`],
  )
  return result.rows
}

export async function enqueueDeadLetter(
  url: string,
  source: string,
  errorMessage: string | null,
  retryCount: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO dead_letter_queue (url, source, error_message, retry_count)
     VALUES ($1, $2, $3, $4)`,
    [url, source, errorMessage, retryCount],
  )
}

export async function trackSearchQuery(
  workerName: string,
  query: string,
  sourceApi: string,
  resultsCount: number,
  discoveriesCount: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO search_queries (worker_name, query, source_api, results_count, discoveries_count)
     VALUES ($1, $2, $3, $4, $5)`,
    [workerName, query, sourceApi, resultsCount, discoveriesCount],
  )
}

export async function resetDailyQuotas(): Promise<void> {
  await pool.query('DELETE FROM api_usage WHERE date < CURRENT_DATE')
}

export async function queryBrands(): Promise<Array<{ name: string; domain: string; category: string; likely_referral_page: string | null; is_active: boolean }>> {
  const result = await pool.query(
    'SELECT name, domain, category, likely_referral_page, is_active FROM brands ORDER BY name',
  )
  return result.rows
}

export async function upsertBrand(
  name: string,
  domain: string,
  category: string,
  likelyReferralPage?: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO brands (name, domain, category, likely_referral_page)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (domain) DO UPDATE SET
       name = $1, category = $3, likely_referral_page = COALESCE($4, brands.likely_referral_page),
       updated_at = NOW()`,
    [name, domain.toLowerCase(), category, likelyReferralPage ?? null],
  )
}

export async function deactivateBrand(domain: string): Promise<void> {
  await pool.query(
    'UPDATE brands SET is_active = false, updated_at = NOW() WHERE domain = $1',
    [domain.toLowerCase()],
  )
}

export async function getHealthStats() {
  const [activeResult, discoveredResult, verResult] = await Promise.all([
    pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM referrals WHERE is_active = true"),
    pool.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM referrals WHERE discovered_at > NOW() - INTERVAL '1 day'"),
    pool.query("SELECT worker_name, started_at, status FROM worker_runs WHERE started_at > NOW() - INTERVAL '1 hour' ORDER BY started_at DESC"),
  ])
  return {
    totalActive: activeResult.rows[0]?.count ?? 0,
    discoveredToday: discoveredResult.rows[0]?.count ?? 0,
    workerRuns: verResult.rows,
  }
}
