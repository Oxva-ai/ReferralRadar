import { pool } from '../db/pool.js'
import { logger } from '../logger.js'

// Bootstrap fallback — used when DB is unavailable
export const SKIP_DOMAINS = [
  // Aggregator/referral code sites
  'getareferral.com', 'thereferralguy.com', 'referralcodes.com',
  'referralcode.org', 'referralcodes.co.uk', 'referralfinder.com',
  'referralhero.com', 'referralhub.com', 'refer-me.com',
  'referral.link', 'referral.world', 'invite.codes',
  // Forums / Q&A
  'reddit.com', 'quora.com', 'stackexchange.com',
  'stackoverflow.com', 'medium.com',
  // Competitor aggregators
  'hotukdeals.com', 'moneysavingexpert.com', 'latestdeals.co.uk',
  'magicfreebiesuk.co.uk', 'myvouchercodes.co.uk', 'vouchercodes.co.uk',
  // Personal/social
  'linktr.ee', 'bio.link', 'beacons.ai', 'carrd.co',
  'tiktok.com', 'instagram.com', 'facebook.com', 'twitter.com',
  'x.com', 'youtube.com', 'linkedin.com',
  // File hosting / docs
  'docs.google.com', 'drive.google.com', 'imgbb.com', 'imgur.com',
  'dropbox.com', 'pastebin.com', 'github.com',
  // Survey/offer walls
  'fivesurveys.com', 'swagbucks.com', 'freecash.com',
  'inboxpounds.co.uk', 'test.io', 'testingtime.com',
  // Generic non-referral
  'google.com', 'bing.com', 'yahoo.com',
  // Global companies passing UK filter via .co.uk mirror — not UK-specific
  'rakuten.com', 'tesla.com',
  // Aggregator / spam sites
  'energy-review.co.uk', 'finder.com', 'finder.co.uk',
  'referandsave.co.uk', 'householdmoneysaving.com',
  'refermehappy.com', 'referral-links.uk',
  'octopusreferraldeals.co.uk', 'octopus-referral-code.co.uk',
  'tesla-referral.uk', 'web-tips.co.uk', 'scrimpr.co.uk',
  'capitalmatters.co.uk', 'mysidegig.co.uk', 'orderwise.co.uk',
  'homelyeconomics.com', 'confused.com', 'comparethemarket.com',
  'gocompare.com', 'moneysupermarket.com', 'trustpilot.com',
  'uk.trustpilot.com', 'referralcodes.uk', 'couponbirds.com',
  'promocodes.com', 'hotoffers.co.uk', 'vouchercodes.org.uk',
  'vouchercloud.com', 'grabon.in', 'couponfollow.com',
  'joinhoney.com', 'picoworkers.com', 'sproutgigs.com',
  'ysense.com', 'thisismoney.co.uk', 'lovemoney.com',
]

let _blockedSet: Set<string> = new Set(SKIP_DOMAINS)
let _blockedLoadPromise: Promise<void> | null = null

async function loadBlockedDomains(): Promise<void> {
  try {
    const result = await pool.query<{ domain: string }>(
      'SELECT domain FROM blocked_domains',
    )
    const merged = new Set(SKIP_DOMAINS)
    for (const row of result.rows) {
      merged.add(row.domain.toLowerCase())
    }
    _blockedSet = merged
  } catch (err) {
    logger.warn({ err }, 'blocked_domains DB load failed, using static SKIP_DOMAINS')
  }
}

function ensureBlockedDomainsLoaded(): void {
  if (!_blockedLoadPromise) {
    _blockedLoadPromise = loadBlockedDomains()
  }
}

ensureBlockedDomainsLoaded()

export function isSkipDomain(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '')
    if (_blockedSet.has(hostname)) return true
    for (const d of _blockedSet) {
      if (hostname.endsWith('.' + d)) return true
    }
    return false
  } catch {
    return true
  }
}


