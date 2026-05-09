import * as cheerio from 'cheerio'
import { logger } from '../logger.js'
import { BRAND_BY_DOMAIN, UK_BRANDS } from '../lib/brands.js'

const JUNK_COMPANY_PATTERNS = /^(refer\s+a\s+friend|referral|get\s+a?\s*referral|sign\s*up|join|home|welcome|invite|free|coupon|voucher|promo|discount|offer|reward|refer|codes?|links?)/i

function stripReferralSuffix(name: string): string {
  return name
    .replace(/\s*[|–—·»]\s*(refer\s+a\s+friend|sign\s*up|offer|free|code|promo|discount|voucher|coupon|referral|invite|reward|bonus|cashback).*$/i, '')
    .replace(/\s*[-–]\s*(refer\s+a\s+friend|sign\s*up|offer|referral|invite|friends?).*$/i, '')
    .replace(/\s+\d{4}\s*$/g, '')
    .replace(/\s*[\([🔗]](?:UK|2024|2025|2026)[\)\]]?\s*$/gi, '')
    .trim()
}

export interface ExtractionResult {
  companyName: string | null
  offerText: string | null
  reward: string | null
  rewardNumeric: number | null
  friendReward: string | null   // keep for backward compat
  refereeReward: string | null  // what the friend/referree actually gets
  referrerReward: string | null // what the referrer gets
  offerSummary: string | null   // human-readable summary
  referralCode: string | null   // extracted code from URL params
  rewardType: 'per_referral' | 'dual' | 'capped' | 'free_product' | 'free_share' | 'switching_bonus' | 'percentage' | 'signup_credit' | 'image_text' | 'unknown'
  currency: string
  referralLink: string | null
  qualifyingSpend: string | null
  maxReferrals: number | null
  termsUrl: string | null       // link to T&Cs
  expiresAt: string | null      // detected expiry date as ISO string
  isInstant: boolean            // signup credit = instant
  isNoId: boolean               // no ID verification needed
  isGambling: boolean           // gambling domain
  requiresSpending: boolean     // has qualifying_spend
  confidence: number | null     // 0-1 score based on signal strength
  multiOfferSegments: string[]
}

// --- Group 1: Standard "you get £X, friend gets £Y" ---
const PATTERN_DUAL = [
  /(?:you(?:'ll)?\s+(?:get|receive|earn))\s*(£\s*\d+\.?\d*).*?(?:friend|they)(?:'ll)?\s+(?:get|receive|earn)\s*(£\s*\d+\.?\d*)/i,
  /(?:both\s+(?:get|receive|earn))\s*(£\s*\d+\.?\d*)/i,
  /(?:each\s+(?:get|receive|earn))\s*(£\s*\d+\.?\d*)/i,
]

// --- Group 2: Per-referral flat rate ---
const PATTERN_PER_REFERRAL = [
  /(?:you(?:'ll)?\s+(?:get|receive|earn))\s*(£\s*\d+\.?\d*)\s*(?:for\s+)?(?:each|every|per)\s+(?:referral|friend|sign.?up)/i,
  /(?:earn|get|receive)\s*(£\s*\d+\.?\d*)\s*per\s+(?:referral|friend|person)/i,
  /(£\s*\d+\.?\d*)\s*per\s+(?:referral|friend|sign.?up)/i,
]

// --- Group 3: Free product / free share ---
const PATTERN_FREE_PRODUCT = [
  /(?:free\s+(?:box|delivery|trial|gift|voucher|coffee|pizza))\b/i,
  /(?:free\s+share\b)/i,
  /(?:get\s+\d+\s+free\s+shares?)/i,
]

// --- Group 4: Switching bonus ---
const PATTERN_SWITCHING = [
  /(?:switch(?:ing)?\s+bonus)/i,
  /(?:switch\s+(?:your|to|bank|account).*?get\s+£)/i,
]

// --- Group 5: Percentage ---
const PATTERN_PERCENTAGE = [
  /(\d{1,3})\s*%\s*(?:off|discount|cashback|back)/i,
  /(?:cashback\s+of\s+(\d{1,3})\s*%)/i,
]

// --- Group 6: Sign-up / joining credit ---
const PATTERN_SIGNUP = [
  /(?:sign.?up\s+(?:bonus|credit|reward|cash|voucher))/i,
  /(?:join(?:ing)?\s+(?:bonus|credit|reward|gift))/i,
  /(?:welcome\s+(?:bonus|offer|gift))/i,
  /(?:get\s+(£\s*\d+\.?\d*)\s*(?:free|just\s+for\s+(?:signing|joining|opening)))/i,
]

// --- Group 7: Capped referrals ---
const PATTERN_CAPPED = [
  /(?:earn\s+up\s+to\s+(£\s*\d+\.?\d*))/i,
  /(?:maximum\s+(?:of\s+)?(£\s*\d+\.?\d*)\s+(?:in\s+)?referral\w*)/i,
  /(?:refer(?:ral|ring)?\s+up\s+to\s+(\d+)\s+friends?)/i,
]

// --- Group 8: GBP amount fallback ---
const PATTERN_FALLBACK = [
  /£\s*(\d+\.?\d*)/,
]

// --- Group 9: Referral code/link patterns (from raw HTML) ---
const REFERRAL_LINK_PATTERNS = [
  /href=["']([^"']*(?:\/?\?.*(?:ref|referral|code|r|invite|friend)=[^"'\s]+))["']/gi,
  /(?:referral\s+code|share\s+this\s+link|your\s+unique\s+link|your referral link|referral link)\s*[:：=]\s*([^\s<"]+)/gi,
  /(https?:\/\/[^\s"'<>]+\/(?:refer|invite)\/[A-Za-z0-9_-]{4,})/gi,
  /((?:go\.|gr\.|lnk\.|ref\.|my\.|get\.|use\.|join\.)\/[A-Za-z0-9_-]{4,})/gi,
  /href=["']([^"']*(?:\/refer\?|\/referral\?)[^"']*)["']/gi,
  /data-referral-link=["']([^"']+)["']/gi,
  /data-ref=["']([^"']*(?:\/?(?:refer|invite|share|earn)\b)[^"']*)["']/gi,
  /onclick=["'][^"']*(https?:\/\/[^"'\s]*(?:ref|referral|invite|code|share)[^"'\s]*)[^"']*["']/gi,
  /href=["']([^"']*(?:\/(?:refer|invite|share|earn)(?:\/[A-Za-z0-9_-]+|\?|#|$))[^"']*)["']/gi,
  /(https?:\/\/(?:bit\.ly|tinyurl\.com|t\.co|ow\.ly|buff\.ly|is\.gd|cutt\.ly|rebrand\.ly|short\.link|click\.link)\/[^\s"'<>]+)/gi,
  /(?:window\.)?location\.(?:href|assign)\s*=\s*["']([^"']*(?:ref|referral|invite|code)[^"']*)["']/gi,
  /navigator\.(?:clipboard\.writeText|share)\s*\(\s*["']([^"']+)["']/gi,
]

const TERMS_URL_PATTERNS = [
  /href=["']([^"']*(?:terms|conditions|tandc|t&c|tc|legal)[^"']*)["']/gi,
  /(?:terms\s+(?:and\s+)?conditions|T&Cs|full\s+terms)\s*(?::|–|—)?\s*(https?:\/\/[^\s<"']+)/gi,
]

const EXPIRY_PATTERNS = [
  /(?:offer\s+)?(?:expires?|ends?|valid\s+(?:until|till|through)|closes?)\s*(?::|–|—)?\s*(\d{1,2}\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4})/i,
  /(?:offer\s+)?(?:expires?|ends?|valid\s+(?:until|till|through)|closes?)\s*(?::|–|—)?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
  /(?:offer\s+)?(?:expires?|ends?|valid\s+(?:until|till|through)|closes?)\s*(?::|–|—)?\s*(\d{4}-\d{2}-\d{2})/i,
]

export function extractText($: cheerio.CheerioAPI): string {
  $('script, style, nav, footer, header, noscript, iframe, svg, img').remove()

  const containers = [
    '[id*="refer"]', '[class*="refer"]',
    '[id*="invite"]', '[class*="invite"]',
    '[id*="earn"]', '[class*="earn"]',
    'main', 'article', '[role="main"]',
    '.content', '#content', 'body',
  ]

  for (const selector of containers) {
    const el = $(selector).first()
    if (el.length && el.text().trim().length > 100)
      return el.text().replace(/\s+/g, ' ').trim()
  }

  return $('body').text().replace(/\s+/g, ' ').trim()
}

export function extractImageText($: cheerio.CheerioAPI): string[] {
  const altTexts: string[] = []
  $('img[alt]').each((_, el) => {
    const alt = $(el).attr('alt')?.trim()
    if (alt && alt.length > 20)
      altTexts.push(alt)
  })
  return altTexts
}

function cleanDomainName(domain: string): string {
  let hostname = domain
  try {
    hostname = new URL(domain.startsWith('http') ? domain : `https://${domain}`).hostname
  } catch { /* use as-is */ }

  hostname = hostname.replace(/^www\./, '')
  const parts = hostname.split('.')
  const prefixes = new Set(['www', 'app', 'go', 'my', 'get'])

  const meaningful = parts.filter((p, i) => {
    if (i >= parts.length - 2 && p.length <= 3) return false
    if (prefixes.has(p.toLowerCase())) return false
    return true
  })

  if (meaningful.length === 0 && parts.length >= 3) {
    meaningful.push(parts[parts.length - 3]!)
  }
  if (meaningful.length === 0 && parts.length >= 1) {
    meaningful.push(parts[0]!)
  }

  const name = meaningful[0]!
  return name.charAt(0).toUpperCase() + name.slice(1)
}

export function extractCompanyName($: cheerio.CheerioAPI, url: string): string {
  let hostname = ''
  try {
    hostname = new URL(url).hostname.replace(/^www\./, '')
  } catch { /* pass */ }

  // 1. Brand list lookup by domain
  if (hostname) {
    const brand = BRAND_BY_DOMAIN[hostname]
    if (brand) return brand.name
  }

  // 2. og:site_name
  const ogSite = $('meta[property="og:site_name"]').attr('content')
  if (ogSite && ogSite.length > 2 && ogSite.length < 60 && !JUNK_COMPANY_PATTERNS.test(ogSite)) {
    return ogSite.trim()
  }

  // 3. h1 heading
  const h1 = $('h1').first().text().trim()
  if (h1 && h1.length > 2 && h1.length < 80 && !JUNK_COMPANY_PATTERNS.test(h1)) {
    const cleaned = stripReferralSuffix(h1)
    if (cleaned.length > 2) return cleaned
  }

  // 4. Title with separators
  const title = $('title').text().trim()
  if (title && title.length > 2) {
    const parts = title.split(/[|–—·»::]/)
    for (const part of parts) {
      const clean = part.trim()
      const brand = UK_BRANDS.find(b => b.name.toLowerCase() === clean.toLowerCase())
      if (brand) return brand.name
    }

    const first = stripReferralSuffix(parts[0]!.trim())
    if (first.length > 2 && first.length < 60 && !JUNK_COMPANY_PATTERNS.test(first)) {
      return first
    }
  }

  // 5. Fallback to brand list by domain
  if (hostname) {
    const brand = BRAND_BY_DOMAIN[hostname]
    if (brand) return brand.name
  }

  // 6. Cleaned domain name
  if (hostname) return cleanDomainName(hostname)
  return url
}

function extractReferralCode(text: string, referralLink: string | null): string | null {
  // First check the referral link for code params
  if (referralLink) {
    try {
      const url = new URL(referralLink)
      const codeParams = ['ref', 'referral', 'code', 'r', 'invite', 'friend', 'raf']
      for (const param of codeParams) {
        const val = url.searchParams.get(param)
        if (val && val.length >= 4 && val.length <= 64) return val
      }
    } catch { /* not a valid URL */ }
  }

  // Check offer text for inline codes
  const codePatterns = [
    /(?:referral\s+code|invite\s+code|promo\s+code|code)\s*(?::|–|—)?\s*["'`]?([A-Za-z0-9_-]{4,20})["'`]?/i,
    /(?:use\s+(?:code|link)\s+["'`]?([A-Za-z0-9_-]{4,20})["'`]?)/i,
  ]
  for (const pattern of codePatterns) {
    const match = text.match(pattern)
    if (match?.[1]) return match[1].trim()
  }

  return null
}

function generateOfferSummary(
  rewardType: ExtractionResult['rewardType'],
  reward: string | null,
  referrerReward: string | null,
  refereeReward: string | null,
  qualifyingSpend: string | null,
  maxReferrals: number | null,
): string | null {
  if (!reward && !referrerReward) return null

  const parts: string[] = []

  if (referrerReward && refereeReward && referrerReward !== refereeReward) {
    parts.push(`You get ${referrerReward}, your friend gets ${refereeReward}`)
  } else if (referrerReward && refereeReward) {
    parts.push(`Both get ${referrerReward}`)
  } else if (referrerReward) {
    parts.push(`You get ${referrerReward}`)
  } else if (reward) {
    parts.push(`Earn ${reward}`)
  }

  if (maxReferrals) {
    parts.push(`(max ${maxReferrals} referrals)`)
  }
  if (qualifyingSpend) {
    parts.push(`with ${qualifyingSpend}`)
  }

  return parts.length > 0 ? parts.join(' ') : null
}

export function splitOffers(text: string): string[] {
  const segments = text.split(/(?:\n|^)\s*(?:\d+[.)]|\b(?:Next|Also|Additionally))\s*/)
    .filter(s => s.trim().length > 100)
    .filter(s => /[£€$]/.test(s))

  if (segments.length >= 2) return segments
  return [text]
}

function extractReferralLinkFromRaw(html: string): string | null {
  const matched: string[] = []

  for (const pattern of REFERRAL_LINK_PATTERNS) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(html)) !== null) {
      const link = (match[1] || match[0])?.trim()
      if (link && link.length >= 4 && !matched.includes(link)) {
        matched.push(link)
      }
    }
  }

  return matched[0] ?? null
}

function extractReferralLinkFromScripts(rawHtml: string): string | null {
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi
  let scriptMatch
  const matched: string[] = []

  while ((scriptMatch = scriptRegex.exec(rawHtml)) !== null) {
    const content = scriptMatch[1]
    if (!content || content.length < 10) continue

    const constVarPatterns = [
      /(?:const|let|var)\s+(?:\w*[Rr]eferral\w*|\w*[Rr]ef\w*|\w*[Ii]nvite\w*|\w*[Ss]hare\w*)\s*=\s*["']([^"']{10,})["']/g,
      /(?:const|let|var)\s+\w+\s*=\s*["']([^"']*(?:ref=|referral=|invite=|code=)[^"']*)["']/g,
    ]

    for (const p of constVarPatterns) {
      p.lastIndex = 0
      let cm
      while ((cm = p.exec(content)) !== null) {
        const link = cm[1]
        if (link && !matched.includes(link)) {
          matched.push(link)
        }
      }
    }

    const clipboardPattern = /navigator\.clipboard\.writeText\s*\(\s*["']([^"']{10,})["']\s*\)/g
    clipboardPattern.lastIndex = 0
    let cpm
    while ((cpm = clipboardPattern.exec(content)) !== null) {
      const link = cpm[1]
      if (link && !matched.includes(link)) {
        matched.push(link)
      }
    }

    const urlPattern = /["'](https?:\/\/[^"']*(?:ref=|referral=|invite=|code=|ref%3D|referral%3D)[^"']*)["']/gi
    urlPattern.lastIndex = 0
    let um
    while ((um = urlPattern.exec(content)) !== null) {
      const link = um[1]
      if (link && !matched.includes(link)) {
        matched.push(link)
      }
    }
  }

  return matched[0] ?? null
}

function extractReferralLinkFromMeta(rawHtml: string): string | null {
  const metaRegex = /<meta\b[^>]*>/gi
  let metaMatch

  while ((metaMatch = metaRegex.exec(rawHtml)) !== null) {
    const tag = metaMatch[0]
    if (!tag) continue

    const ogUrl = tag.match(/(?:property|name)=["']og:url["']\s+content=["']([^"']+)["']/i)
      ?? tag.match(/content=["']([^"']+)["']\s+(?:property|name)=["']og:url["']/i)
    if (ogUrl?.[1] && /[?&](?:ref|referral|invite|code|r)=/.test(ogUrl[1])) {
      return ogUrl[1]
    }

    const twitterUrl = tag.match(/(?:property|name)=["']twitter:url["']\s+content=["']([^"']+)["']/i)
      ?? tag.match(/content=["']([^"']+)["']\s+(?:property|name)=["']twitter:url["']/i)
    if (twitterUrl?.[1] && /[?&](?:ref|referral|invite|code|r)=/.test(twitterUrl[1])) {
      return twitterUrl[1]
    }

    const contentMatch = tag.match(/content=["']([^"']*(?:ref(?:err?al)?=|invite=|code=|r=|referral\/|\/(?:refer|invite|share|earn)\/)[^"']*)["']/i)
    if (contentMatch?.[1]) return contentMatch[1]
  }

  return null
}

function extractReward(text: string): {
  reward: string | null
  rewardNumeric: number | null
  friendReward: string | null
  refereeReward: string | null
  referrerReward: string | null
  rewardType: ExtractionResult['rewardType']
  maxReferrals: number | null
} {
  let reward: string | null = null
  let rewardNumeric: number | null = null
  let friendReward: string | null = null
  let refereeReward: string | null = null
  let referrerReward: string | null = null
  let rewardType: ExtractionResult['rewardType'] = 'unknown'
  let maxReferrals: number | null = null

  // Check dual rewards first
  for (const pattern of PATTERN_DUAL) {
    const match = text.match(pattern)
    if (match) {
      if (match[1] && match[2]) {
        reward = match[1]
        rewardNumeric = parseFloat(reward.replace(/[^0-9.]/g, ''))
        friendReward = match[2]
        referrerReward = match[1]
        refereeReward = match[2]
        rewardType = 'dual'
        return { reward, rewardNumeric, friendReward, refereeReward, referrerReward, rewardType, maxReferrals }
      }
      reward = match[1]!
      rewardNumeric = parseFloat(reward.replace(/[^0-9.]/g, ''))
      friendReward = match[1]!
      referrerReward = match[1]!
      refereeReward = match[1]!
      rewardType = 'dual'
      return { reward, rewardNumeric, friendReward, refereeReward, referrerReward, rewardType, maxReferrals }
    }
  }

  // Check per-referral
  for (const pattern of PATTERN_PER_REFERRAL) {
    const match = text.match(pattern)
    if (match) {
      reward = match[1]!
      rewardNumeric = parseFloat(reward.replace(/[^0-9.]/g, ''))
      referrerReward = match[1]!
      rewardType = 'per_referral'
      return { reward, rewardNumeric, friendReward: null, refereeReward: null, referrerReward, rewardType, maxReferrals }
    }
  }

  // Check free product
  for (const pattern of PATTERN_FREE_PRODUCT) {
    const match = text.match(pattern)
    if (match) {
      reward = match[0]
      rewardNumeric = 10 // Default estimated value for free products
      rewardType = match[0].includes('share') ? 'free_share' : 'free_product'
      return { reward, rewardNumeric, friendReward: null, refereeReward: null, referrerReward: null, rewardType, maxReferrals }
    }
  }

  // Check switching bonus
  for (const pattern of PATTERN_SWITCHING) {
    const match = text.match(pattern)
    if (match) {
      rewardType = 'switching_bonus'
      // Try to extract GBP amount
      const gbpMatch = text.match(/£\s*(\d+\.?\d*)/)
      if (gbpMatch) {
        reward = gbpMatch[0]
        rewardNumeric = parseFloat(gbpMatch[1]!)
      }
      return { reward, rewardNumeric, friendReward: null, refereeReward: null, referrerReward: null, rewardType, maxReferrals }
    }
  }

  // Check percentage
  for (const pattern of PATTERN_PERCENTAGE) {
    const match = text.match(pattern)
    if (match) {
      reward = match[0]
      rewardNumeric = parseFloat(match[1]!) // The percentage value
      rewardType = 'percentage'
      return { reward, rewardNumeric, friendReward: null, refereeReward: null, referrerReward: null, rewardType, maxReferrals }
    }
  }

  // Check signup bonus
  for (const pattern of PATTERN_SIGNUP) {
    const match = text.match(pattern)
    if (match) {
      rewardType = 'signup_credit'
      if (match[1]) {
        reward = match[1]
        rewardNumeric = parseFloat(reward.replace(/[^0-9.]/g, ''))
      }
      return { reward, rewardNumeric, friendReward: null, refereeReward: null, referrerReward: null, rewardType, maxReferrals }
    }
  }

  // Check capped — run all patterns, merge results
  let cappedReward: string | null = null
  let cappedNumeric: number | null = null
  let cappedMax: number | null = null

  for (const pattern of PATTERN_CAPPED) {
    const match = text.match(pattern)
    if (!match) continue

    if (match[1] && match[1].startsWith('£')) {
      cappedReward = match[1]
      cappedNumeric = parseFloat(cappedReward.replace(/[^0-9.]/g, ''))
    }
    if (match[1] && /^\d+$/.test(match[1])) {
      cappedMax = parseInt(match[1], 10)
    }
    if (match[2] && /^\d+$/.test(match[2])) {
      cappedMax = parseInt(match[2], 10)
    }
  }

  if (cappedReward || cappedMax) {
    return { reward: cappedReward, rewardNumeric: cappedNumeric, friendReward: null, refereeReward: null, referrerReward: null, rewardType: 'capped', maxReferrals: cappedMax }
  }

  // Fallback: any GBP amount
  for (const pattern of PATTERN_FALLBACK) {
    const match = text.match(pattern)
    if (match) {
      reward = match[0]
      rewardNumeric = parseFloat(match[1]!)
      rewardType = 'per_referral'
      return { reward, rewardNumeric, friendReward: null, refereeReward: null, referrerReward: null, rewardType, maxReferrals }
    }
  }

  return { reward: null, rewardNumeric: null, friendReward: null, refereeReward: null, referrerReward: null, rewardType: 'unknown', maxReferrals: null }
}

function extractQualifyingSpend(text: string): string | null {
  const patterns = [
    /(?:minimum\s+(?:spend|deposit|purchase|order|trade)\s*(?:of|is)\s*(£\s*\d+\.?\d*))/i,
    /(?:spend\s+(?:at\s+least\s+)?(£\s*\d+\.?\d*))/i,
    /(?:deposit\s+(?:at\s+least\s+)?(£\s*\d+\.?\d*))/i,
    /(?:trade\s+(?:at\s+least\s+)?(£\s*\d+\.?\d*))/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return match[0]
  }

  return null
}

export async function extract(html: string, url: string): Promise<ExtractionResult | null> {
  try {
    const $ = cheerio.load(html)

    // Extract image alt texts BEFORE extractText removes images
    const altTexts = extractImageText($)
    const text = extractText($)

    if (!text || text.length < 50) {
      logger.debug({ url }, 'insufficient text for extraction')
      return null
    }

    // Check for Cloudflare challenge page
    if (
      text.includes('Just a moment') ||
      text.includes('Enable JavaScript') ||
      text.includes('Checking your browser')
    ) {
      logger.warn({ url }, 'Cloudflare challenge detected, cannot extract')
      return null
    }

    const companyName = extractCompanyName($, url)
    const referralLink = extractReferralLinkFromRaw(html)
      ?? extractReferralLinkFromScripts(html)
      ?? extractReferralLinkFromMeta(html)
    const extraction = extractReward(text)
    const qualifyingSpend = extractQualifyingSpend(text)

    let offerText: string

    // Image alt text fallback: if no GBP found in text, check images
    if (extraction.rewardType === 'unknown') {
      for (const alt of altTexts) {
        const altCheck = extractReward(alt)
        if (altCheck.rewardType !== 'unknown') {
          extraction.reward = altCheck.reward
          extraction.rewardNumeric = altCheck.rewardNumeric
          extraction.friendReward = altCheck.friendReward
          extraction.rewardType = 'image_text'
          break
        }
      }
    }

    // If still no reward found, set to unknown with text
    if (extraction.rewardType === 'unknown') {
      offerText = text.substring(0, 500)
    } else {
      offerText = text.substring(0, 1000)
    }

    // Multi-offer splitting
    const segments = text.length > 2000 ? splitOffers(text) : [text]

    // Extract referral code
    const referralCode = extractReferralCode(text, referralLink)

    // Extract terms URL
    let termsUrl: string | null = null
    let hostname = ''
    try { hostname = new URL(url).hostname } catch { /* ignore */ }
    for (const pattern of TERMS_URL_PATTERNS) {
      pattern.lastIndex = 0
      const match = pattern.exec(html)
      if (match?.[1]) {
        termsUrl = match[1].startsWith('http') ? match[1] : `https://${hostname}${match[1]}`
        break
      }
    }

    // Extract expiry
    let expiresAt: string | null = null
    for (const pattern of EXPIRY_PATTERNS) {
      const match = text.match(pattern)
      if (match?.[1]) {
        const parsed = new Date(match[1])
        if (!isNaN(parsed.getTime())) {
          expiresAt = parsed.toISOString()
        }
        break
      }
    }

    // Boolean heuristics
    const isInstant = extraction.rewardType === 'signup_credit' || /instant/i.test(text)
    const isNoId = !!/\bcode\b/i.test(text) || !!referralCode
    const isGambling = /bet|casino|gambl|poker|slot/i.test(text)
    const requiresSpending = qualifyingSpend !== null

    // Confidence score based on signal quality
    const confidence = (() => {
      let score = 0
      if (extraction.rewardNumeric !== null && extraction.rewardNumeric > 0) score += 0.4
      if (referralLink) score += 0.2
      if (referralCode) score += 0.1
      if (companyName && companyName.length > 2 && !JUNK_COMPANY_PATTERNS.test(companyName)) score += 0.2
      if (extraction.rewardType !== 'unknown') score += 0.1
      return Math.min(score, 1)
    })()

    // Generate offer summary
    const offerSummary = generateOfferSummary(
      extraction.rewardType,
      extraction.reward,
      extraction.referrerReward,
      extraction.refereeReward,
      qualifyingSpend,
      extraction.maxReferrals,
    )

    return {
      companyName,
      offerText,
      reward: extraction.reward,
      rewardNumeric: extraction.rewardNumeric,
      friendReward: extraction.friendReward,
      refereeReward: extraction.refereeReward,
      referrerReward: extraction.referrerReward,
      offerSummary,
      referralCode,
      rewardType: extraction.rewardType,
      currency: 'GBP',
      referralLink,
      qualifyingSpend,
      maxReferrals: extraction.maxReferrals,
      termsUrl,
      expiresAt,
      isInstant,
      isNoId,
      isGambling,
      requiresSpending,
      confidence,
      multiOfferSegments: segments,
    }
  } catch (err) {
    logger.error({ err, url }, 'extraction failed')
    return null
  }
}
