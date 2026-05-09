import { describe, it, expect } from 'vitest'
import { checkUkMarket } from '../src/services/uk-filter.js'

describe('checkUkMarket', () => {
  it('passes strong: .co.uk + GBP + UK geo text', () => {
    const result = checkUkMarket(
      'https://example.co.uk/refer',
      'Get £10 when you refer a friend in the United Kingdom',
    )
    expect(result.pass).toBe(true)
    expect(result.signal).toBe('strong')
    expect(result.hasCoUkTld).toBe(true)
    expect(result.hasPound).toBe(true)
    expect(result.hasGeoText).toBe(true)
  })

  it('passes strong: .co.uk + GBP', () => {
    const result = checkUkMarket(
      'https://bank.co.uk/refer',
      'Earn £25 per referral',
    )
    expect(result.pass).toBe(true)
    expect(result.signal).toBe('strong')
  })

  it('passes strong: .co.uk + UK geo text', () => {
    const result = checkUkMarket(
      'https://shop.co.uk/friends',
      'Available for London and Manchester residents',
    )
    expect(result.pass).toBe(true)
    expect(result.signal).toBe('strong')
  })

  it('passes moderate: GBP + UK geo text (no .co.uk)', () => {
    const result = checkUkMarket(
      'https://example.com/refer',
      'Get £5 for each friend in Scotland',
    )
    expect(result.pass).toBe(true)
    expect(result.signal).toBe('moderate')
  })

  it('passes pound_only: GBP only', () => {
    const result = checkUkMarket(
      'https://globalbank.com/refer',
      'Earn £100 for signing up',
    )
    expect(result.pass).toBe(true)
    expect(result.signal).toBe('pound_only')
  })

  it('passes moderate: FCA mention', () => {
    const result = checkUkMarket(
      'https://finance.com/join',
      'Regulated by the FCA',
    )
    expect(result.pass).toBe(true)
    expect(result.signal).toBe('moderate')
    expect(result.hasFca).toBe(true)
  })

  it('discards non-UK TLD with no UK signals', () => {
    const result = checkUkMarket(
      'https://example.de/referral',
      'Verdienen Sie 10 Euro',
    )
    expect(result.pass).toBe(false)
    expect(result.signal).toBe('discard')
  })

  it('discards USD with US cities, no UK signals', () => {
    const result = checkUkMarket(
      'https://app.com/refer',
      'Get $20 for each friend in New York and Los Angeles',
    )
    expect(result.pass).toBe(false)
    expect(result.signal).toBe('discard')
  })

  it('discards EUR only, no UK TLD or geo text', () => {
    const result = checkUkMarket(
      'https://example.com/refer',
      'Verdien 10 EUR',
    )
    expect(result.pass).toBe(false)
    expect(result.signal).toBe('discard')
  })

  it('identifies .org.uk as UK TLD', () => {
    const result = checkUkMarket(
      'https://charity.org.uk/refer',
      '£5 for each referral',
    )
    expect(result.pass).toBe(true)
    expect(result.hasCoUkTld).toBe(true)
    expect(result.signal).toBe('strong')
  })

  it('identifies .gov.uk as UK TLD', () => {
    const result = checkUkMarket(
      'https://service.gov.uk/info',
      'Information for United Kingdom residents',
    )
    expect(result.pass).toBe(true)
    expect(result.hasCoUkTld).toBe(true)
    expect(result.signal).toBe('strong')
  })

  it('identifies FSCS mention as FCA signal', () => {
    const result = checkUkMarket(
      'https://bank.com/terms',
      'Protected by FSCS up to £85000',
    )
    expect(result.pass).toBe(true)
    expect(result.hasFca).toBe(true)
    expect(result.hasPound).toBe(true)
  })

  it('identifies PRA mention as FCA signal', () => {
    const result = checkUkMarket(
      'https://bank.com/regulatory',
      'Authorised by the PRA',
    )
    expect(result.pass).toBe(true)
    expect(result.hasFca).toBe(true)
  })

  it('passes .london TLD', () => {
    const result = checkUkMarket(
      'https://company.london/jobs',
      'Jobs in London',
    )
    expect(result.pass).toBe(true)
    expect(result.hasCoUkTld).toBe(true)
  })

  it('passes .scot TLD', () => {
    const result = checkUkMarket(
      'https://business.scot/offers',
      '£10 off in Scotland',
    )
    expect(result.pass).toBe(true)
    expect(result.hasCoUkTld).toBe(true)
  })

  it('handles malformed URLs gracefully', () => {
    const result = checkUkMarket(
      'not-a-url',
      '£5 for each friend in London',
    )
    expect(result.pass).toBe(true)
    expect(result.signal).toBe('moderate')
    expect(result.hasCoUkTld).toBe(false)
  })
})
