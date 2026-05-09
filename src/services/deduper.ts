import { logger } from '../logger.js'
import { fireEvent } from './webhook-service.js'
import { computeContentHash } from '../lib/hash.js'
import { pool } from '../db/pool.js'
import { isSkipDomain } from '../lib/blocklist.js'
import { BRAND_BY_DOMAIN, getCompanyName, getCategory, UK_BRANDS } from '../lib/brands.js'
import { normalizeUrl } from '../lib/url.js'
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
  // Layer 1: Exact URL match (normalized)
  const normalizedUrl = normalizeUrl(url)
  let urlMatch = await findReferralBySourceUrl(normalizedUrl)
  if (!urlMatch && normalizedUrl !== url) {
    urlMatch = await findReferralBySourceUrl(url)
  }
  if (urlMatch) {
    logger.debug({ url, normalizedUrl, existingId: urlMatch.id }, 'dedup L1: exact URL match, skipping')
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

function cleanCompanyName(raw: string, domain: string): string {
  let name = raw.trim()

  // 1. Brand list lookup by domain
  if (domain) {
    const brand = BRAND_BY_DOMAIN[domain] ?? BRAND_BY_DOMAIN[`www.${domain}`]
    if (brand) return brand.name
  }

  // 2. Strip pipe/dash suffixes
  if (name.includes('|')) {
    const parts = name.split('|').map(p => p.trim())
    for (let i = parts.length - 1; i >= 0; i--) {
      const brand = UK_BRANDS.find(b => b.name.toLowerCase() === parts[i]!.toLowerCase())
      if (brand) return brand.name
    }
    const stripped = parts[0]!.replace(/\s*(refer\s+a\s+friend|referral|sign\s*up|offer|code|promo|discount|voucher|coupon)\s*/gi, '').trim()
    if (stripped.length > 2) name = stripped
  }

  if (name.includes('—')) name = name.split('—')[0]!.trim()
  if (name.includes('–')) name = name.split('–')[0]!.trim()

  name = name
    .replace(/\s*[-—–]\s*(referral|refer a friend|sign up|signup|invite friends|invite).*$/i, '')
    .replace(/\s+\d{4}\s*$/g, '')
    .replace(/\s*[\([🔗]](?:UK|2024|2025|2026)[\)\]]?\s*$/gi, '')
    .trim()

  // 3. Junk name rejection
  const JUNK_NAMES = new Set([
    'home', 'i', 'me', 'my', 'refer', 'get a referral', 'referral code',
    'join', 'sign up', 'referral', 'invite', 'welcome', 'free', 'offer',
    'coupon', 'voucher', 'promo', 'discount', 'deal', 'unknown',
  ])
  if (!name || name.length < 2 || JUNK_NAMES.has(name.toLowerCase())) {
    if (domain) {
      const brand = BRAND_BY_DOMAIN[domain] ?? BRAND_BY_DOMAIN[`www.${domain}`]
      if (brand) return brand.name
    }
    const domainRoot = domain.split('.')[0]!
    return domainRoot.charAt(0).toUpperCase() + domainRoot.slice(1)
  }

  // 4. Known brand fuzzy match
  for (const brand of UK_BRANDS) {
    if (brand.name.length > 3 && name.toLowerCase().includes(brand.name.toLowerCase())) {
      return brand.name
    }
  }

  // 5. Length sanity
  if (name.length > 60) {
    if (domain) {
      const brand = BRAND_BY_DOMAIN[domain] ?? BRAND_BY_DOMAIN[`www.${domain}`]
      if (brand) return brand.name
    }
    const domainRoot = domain.split('.')[0]!
    return domainRoot.charAt(0).toUpperCase() + domainRoot.slice(1)
  }

  return name
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
  const normalizedUrl = normalizeUrl(url)

  // Quality gate: reject known spam domains
  if (isSkipDomain(normalizedUrl)) {
    logger.debug({ url: normalizedUrl }, 'quality gate: blocked domain')
    return null
  }

  // Quality gate: must have at least one of: GBP amount, referral link, or UK TLD
  const hasValue = extracted.rewardNumeric !== null
  const hasLink = extracted.referralLink !== null
  const hasCoUk = normalizedUrl.includes('.co.uk') || normalizedUrl.includes('.uk/')
  if (!hasValue && !hasLink && !hasCoUk) {
    logger.debug({ url: normalizedUrl, rewardType: extracted.rewardType }, 'quality gate: no GBP, no link, no UK TLD')
    return null
  }

  // Quality gate: company name must be meaningful
  const rawName = extracted.companyName ?? ''
  const domain = extractDomain(normalizedUrl) ?? ''
  const name = cleanCompanyName(rawName, domain)
  const junkNames = ['home', 'i', 'me', 'my', 'refer', 'get a referral', 'referral code', 'join', 'sign up']
  if (!name || name.length < 2 || junkNames.includes(name.toLowerCase())) {
    logger.debug({ url: normalizedUrl, companyName: name }, 'quality gate: bad company name')
    return null
  }

  // Override extracted company name with cleaned version for dedup
  const extractionForDedup: ExtractionResult = { ...extracted, companyName: name }

  // Aggregator detection: 3+ unique GBP amounts on one page
  let isAggregator = false
  if (extracted.offerText) {
    const amounts = extracted.offerText.match(/£\s*\d+\.?\d*/g) ?? []
    const unique = new Set(amounts)
    if (unique.size >= 3) {
      isAggregator = true
      logger.debug({ url: normalizedUrl, uniqueAmounts: unique.size }, 'aggregator detected: 3+ unique GBP amounts')
    }
  }

  const dedupResult = await checkDedup(normalizedUrl, extractionForDedup.offerText, extractionForDedup.companyName, domain)

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
    logger.info({ id: dedupResult.existingId, url: normalizedUrl, source }, 'merged into existing referral')
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
      [normalizedUrl, dedupResult.existingId],
    )
    logger.info({ id: dedupResult.existingId, url: normalizedUrl }, 'reactivated referral')
    return dedupResult.existingId
  }

  // Same-domain same-source within 1 hour dedup
  try {
    const dedupHour = await pool.query<{ id: string }>(
      `SELECT id FROM referrals WHERE domain = $1 AND sources @> ARRAY[$2] AND is_active = true AND discovered_at > NOW() - INTERVAL '1 hour' LIMIT 1`,
      [domain, source],
    )
    if (dedupHour.rows.length > 0 && dedupHour.rows[0]) {
      const existingId = dedupHour.rows[0].id
      await pool.query(
        `UPDATE referrals SET source_count = source_count + 1, sources = array_append(sources, $1), updated_at = NOW() WHERE id = $2 AND NOT ($1 = ANY(sources))`,
        [source, existingId],
      )
      logger.info({ id: existingId, url: normalizedUrl, source }, 'merged via domain+source 1h dedup')
      return existingId
    }
  } catch {
    // continue if query fails
  }

  const contentHash = extracted.offerText ? computeContentHash(extracted.offerText) : null

  // Resolve company name and category from brand list
  const brandName = getCompanyName(domain)
  const category = getCategory(domain)
  const finalCompanyName = brandName ?? name
  const finalCategory = category ?? null

  const data: InsertReferral = {
    source_url: normalizedUrl,
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
    is_aggregator: isAggregator,
    referee_reward: extracted.refereeReward,
    referrer_reward: extracted.referrerReward,
    offer_summary: extracted.offerSummary,
    referral_code: extracted.referralCode,
    terms_url: extracted.termsUrl,
    is_instant: extracted.isInstant,
    is_no_id: extracted.isNoId,
    is_gambling: extracted.isGambling,
    requires_spending: extracted.requiresSpending,
    confidence: extracted.confidence,
    reddit_post_id: redditPostId ?? null,
    reddit_score: redditScore ?? null,
    reddit_comments: redditComments ?? null,
    category: finalCategory,
  }

  const row = await insertReferral(data)
  if (row) {
    setImmediate(() => {
      fireEvent('referral.created', {
        referral_id: row.id,
        company_name: row.company_name,
        reward: row.reward,
        reward_numeric: row.reward_numeric,
        referral_link: row.referral_link,
        domain: row.domain,
        discovered_at: row.discovered_at.toISOString(),
      }).catch(err => logger.error({ err }, 'webhook fire failed'))
    })
  }
  logger.info({ id: row.id, url: normalizedUrl, source }, 'stored new referral')
  return row.id
}

function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}
