import { logger } from '../logger.js'
import { computeContentHash } from '../lib/hash.js'
import { pool } from '../db/pool.js'
import { isSkipDomain } from '../lib/blocklist.js'
import { getCompanyName, getCategory } from '../lib/brands.js'
import {
  findReferralBySourceUrl,
  findReferralByContentHash,
  findInactiveReferralByContentHash,
  insertReferral,
  type InsertReferral,
} from '../db/queries.js'
import type { ExtractionResult } from './extractor.js'

export interface DedupResult {
  action: 'skip' | 'merge' | 'insert' | 'reactivate'
  existingId?: string
  reason?: string
}

export async function checkDedup(
  url: string,
  text: string | null,
  companyName: string | null,
  domain: string | null,
): Promise<DedupResult> {
  // Layer 1: Exact URL match
  const urlMatch = await findReferralBySourceUrl(url)
  if (urlMatch) {
    logger.debug({ url, existingId: urlMatch.id }, 'dedup L1: exact URL match, skipping')
    return { action: 'skip', existingId: urlMatch.id, reason: 'exact_url' }
  }

  if (!text) return { action: 'insert' }

  const contentHash = computeContentHash(text)

  // Layer 2: Content hash OR similarity > 0.85
  const hashMatch = await findReferralByContentHash(contentHash)
  if (hashMatch) {
    logger.debug({ url, existingId: hashMatch.id, hash: contentHash }, 'dedup L2: content hash match, merging')
    return { action: 'merge', existingId: hashMatch.id, reason: 'content_hash' }
  }

  // Layer 2b: Similarity check on offer_text (pg_trgm similarity)
  try {
    const simResult = await pool.query<{ id: string }>(
      `SELECT id, offer_text FROM referrals
       WHERE similarity(offer_text, $1) > 0.85
         AND is_active = true
       LIMIT 1`,
      [text],
    )
    if (simResult.rows.length > 0 && simResult.rows[0]) {
      const existingId = simResult.rows[0].id
      logger.debug({ url, existingId, confidence: '>0.85' }, 'dedup L2b: similarity match, merging')
      return { action: 'merge', existingId, reason: 'similarity_085' }
    }
  } catch {
    // similarity() requires pg_trgm extension; skip if not available
  }

  // Check for inactive match with same content hash (reactivate)
  const inactiveMatch = await findInactiveReferralByContentHash(contentHash)
  if (inactiveMatch) {
    logger.info({ url, existingId: inactiveMatch.id }, 'dedup: found inactive match, reactivating')
    return { action: 'reactivate', existingId: inactiveMatch.id, reason: 'reactivate_inactive' }
  }

  // Layer 3: Company + domain fuzzy match (levenshtein < 3)
  if (domain && companyName && companyName.length > 2) {
    try {
      const fuzzyResult = await pool.query<{ id: string; company_name: string }>(
        `SELECT id, company_name FROM referrals r
         WHERE r.domain = $1
           AND levenshtein(r.company_name, $2) < 3
           AND r.is_active = true
         LIMIT 1`,
        [domain, companyName],
      )
      if (fuzzyResult.rows.length > 0 && fuzzyResult.rows[0]) {
        const existingId = fuzzyResult.rows[0].id
        logger.debug({ url, existingId, domain, companyName, matchedCompany: fuzzyResult.rows[0].company_name }, 'dedup L3: fuzzy match, flagging for review')
        return { action: 'merge', existingId, reason: 'fuzzy_company' }
      }
    } catch {
      // levenshtein() requires fuzzystrmatch extension; skip if not available
    }

    // Check inactive referrals too — reactivate if fuzzy match
    try {
      const fuzzyInactive = await pool.query<{ id: string; company_name: string }>(
        `SELECT id, company_name FROM referrals r
         WHERE r.domain = $1
           AND levenshtein(r.company_name, $2) < 3
           AND r.is_active = false
         LIMIT 1`,
        [domain, companyName],
      )
      if (fuzzyInactive.rows.length > 0 && fuzzyInactive.rows[0]) {
        const existingId = fuzzyInactive.rows[0].id
        logger.info({ url, existingId, domain, companyName }, 'dedup L3: fuzzy match on inactive referral, reactivating')
        return { action: 'reactivate', existingId, reason: 'reactivate_fuzzy' }
      }
    } catch {
      // extension not available
    }
  }

  return { action: 'insert' }
}

export async function storeReferral(
  url: string,
  extracted: ExtractionResult,
  source: string,
  ukSignal: string,
  redditPostId?: string | null,
  redditScore?: number | null,
  redditComments?: number | null,
): Promise<string | null> {
  // Quality gate: reject known spam domains
  if (isSkipDomain(url)) {
    logger.debug({ url }, 'quality gate: blocked domain')
    return null
  }

  // Quality gate: must have at least one of: GBP amount, referral link, or UK TLD
  const hasValue = extracted.rewardNumeric !== null
  const hasLink = extracted.referralLink !== null
  const hasCoUk = url.includes('.co.uk') || url.includes('.uk/')
  if (!hasValue && !hasLink && !hasCoUk) {
    logger.debug({ url, rewardType: extracted.rewardType }, 'quality gate: no GBP, no link, no UK TLD')
    return null
  }

  // Quality gate: company name must be meaningful
  const name = extracted.companyName ?? ''
  const junkNames = ['home', 'i', 'me', 'my', 'refer', 'get a referral', 'referral code', 'join', 'sign up']
  if (!name || name.length < 2 || junkNames.includes(name.toLowerCase())) {
    logger.debug({ url, companyName: name }, 'quality gate: bad company name')
    return null
  }

  const dedupResult = await checkDedup(url, extracted.offerText, extracted.companyName, extractDomain(url))

  if (dedupResult.action === 'skip') {
    return dedupResult.existingId ?? null
  }

  if (dedupResult.action === 'merge' && dedupResult.existingId) {
    // Merge: increment source_count, append source
    await pool.query(
      `UPDATE referrals
       SET source_count = source_count + 1,
           sources = array_append(sources, $1),
           updated_at = NOW()
       WHERE id = $2
         AND NOT ($1 = ANY(sources))`,
      [source, dedupResult.existingId],
    )
    logger.info({ id: dedupResult.existingId, url, source }, 'merged into existing referral')
    return dedupResult.existingId
  }

  if (dedupResult.action === 'reactivate' && dedupResult.existingId) {
    await pool.query(
      `UPDATE referrals
       SET is_active = true,
           source_url = COALESCE(source_url, $1),
           updated_at = NOW(),
           last_verified_at = NOW()
       WHERE id = $2`,
      [url, dedupResult.existingId],
    )
    logger.info({ id: dedupResult.existingId, url }, 'reactivated referral')
    return dedupResult.existingId
  }

  const contentHash = extracted.offerText ? computeContentHash(extracted.offerText) : null
  const domain = extractDomain(url) ?? ''

  // Resolve company name and category from brand list
  const brandName = getCompanyName(domain)
  const category = getCategory(domain)
  const finalCompanyName = brandName ?? extracted.companyName
  const finalCategory = category ?? null

  const data: InsertReferral = {
    source_url: url,
    referral_link: extracted.referralLink,
    company_name: finalCompanyName,
    offer_text: extracted.offerText,
    reward: extracted.reward,
    reward_numeric: extracted.rewardNumeric,
    currency: extracted.currency,
    friend_reward: extracted.friendReward,
    reward_type: extracted.rewardType,
    qualifying_spend: extracted.qualifyingSpend,
    max_referrals: extracted.maxReferrals,
    content_hash: contentHash,
    sources: [source],
    source_count: 1,
    uk_signal_strength: ukSignal,
    reddit_post_id: redditPostId ?? null,
    reddit_score: redditScore ?? null,
    reddit_comments: redditComments ?? null,
    category: finalCategory,
  }

  const row = await insertReferral(data)
  logger.info({ id: row.id, url, source }, 'stored new referral')
  return row.id
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
