import {
  UK_STRONG_SIGNALS,
  UK_DOMAIN_TLDS,
  NON_UK_TLDS,
  US_CITIES,
  UK_CITIES,
  type UkSignalStrength,
} from '../lib/uk.js'
import { logger } from '../logger.js'

export interface UkFilterResult {
  pass: boolean
  signal: UkSignalStrength
  reason: string
  hasCoUkTld: boolean
  hasPound: boolean
  hasGeoText: boolean
  hasFca: boolean
}

export function checkUkMarket(url: string, text: string): UkFilterResult {
  const hostname = extractHostname(url)
  const hasCoUkTld = UK_DOMAIN_TLDS.some(tld => hostname.endsWith(tld))
  const isNonUkTld = NON_UK_TLDS.some(tld => hostname.endsWith(tld))
  const hasPound = /£|GBP\b/i.test(text)
  const hasDollarOnly = /\$/.test(text) && !hasPound
  const hasEuroOnly = /€|\bEUR\b/i.test(text) && !hasPound
  const hasGeoText = UK_STRONG_SIGNALS.some(sig =>
    text.toLowerCase().includes(sig.toLowerCase()),
  )
  const hasFca = /\bFCA\b|\bFSCS\b|\bPRA\b/i.test(text)
  const hasUsCities = US_CITIES.some(city =>
    text.toLowerCase().includes(city.toLowerCase()),
  ) && !UK_CITIES.some(city => text.toLowerCase().includes(city.toLowerCase()))

  let signal: UkSignalStrength = 'unknown'
  let pass = false
  let reason = ''

  // Decision matrix per spec Section 5.4
  if (isNonUkTld && !hasPound && !hasGeoText && !hasFca) {
    return { pass: false, signal: 'discard', reason: 'non-UK TLD with no UK signals', hasCoUkTld: false, hasPound: false, hasGeoText: false, hasFca: false }
  }

  if (hasDollarOnly && hasUsCities) {
    return { pass: false, signal: 'discard', reason: 'USD with US cities, no UK signals', hasCoUkTld, hasPound: false, hasGeoText: false, hasFca }
  }

  if (hasEuroOnly && !hasCoUkTld && !hasGeoText) {
    return { pass: false, signal: 'discard', reason: 'EUR only, no UK TLD or geo text', hasCoUkTld, hasPound: false, hasGeoText, hasFca }
  }

  if (hasCoUkTld && hasPound && hasGeoText) {
    signal = 'strong'
    pass = true
    reason = '.co.uk + GBP + UK geo text'
  } else if (hasCoUkTld && hasPound) {
    signal = 'strong'
    pass = true
    reason = '.co.uk + GBP'
  } else if (hasCoUkTld && hasGeoText) {
    signal = 'strong'
    pass = true
    reason = '.co.uk + UK geo text'
  } else if (hasPound && hasGeoText) {
    signal = 'moderate'
    pass = true
    reason = 'GBP + UK geo text'
  } else if (hasPound) {
    signal = 'pound_only'
    pass = true
    reason = 'GBP only (weak)'
  } else if (hasFca) {
    signal = 'moderate'
    pass = true
    reason = 'FCA-regulated'
  } else {
    signal = 'unknown'
    pass = false
    reason = 'no UK signals detected'
  }

  return { pass, signal, reason, hasCoUkTld, hasPound, hasGeoText, hasFca }
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

export function filterUkResults(results: Array<{ url: string; text: string }>): Array<{ url: string; text: string; signal: UkSignalStrength }> {
  const filtered: Array<{ url: string; text: string; signal: UkSignalStrength }> = []
  for (const item of results) {
    const check = checkUkMarket(item.url, item.text)
    if (check.pass) {
      filtered.push({ ...item, signal: check.signal })
    } else {
      logger.debug({ url: item.url, reason: check.reason }, 'discarded non-UK result')
    }
  }
  return filtered
}
