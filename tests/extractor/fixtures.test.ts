import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extract } from '../../src/services/extractor.js'

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name), 'utf-8')
}

describe('extraction fixtures: HelloFresh', () => {
  it('detects dual reward type', async () => {
    const result = await extract(fixture('hellofresh-referral.html'), 'https://www.hellofresh.co.uk/pages/referral')
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('dual')
  })

  it('extracts referrer reward £20', async () => {
    const result = await extract(fixture('hellofresh-referral.html'), 'https://www.hellofresh.co.uk/pages/referral')
    expect(result!.referrerReward).toMatch(/20/)
  })

  it('extracts referee reward £25', async () => {
    const result = await extract(fixture('hellofresh-referral.html'), 'https://www.hellofresh.co.uk/pages/referral')
    expect(result!.refereeReward).toMatch(/25/)
  })

  it('extracts referral link with code param', async () => {
    const result = await extract(fixture('hellofresh-referral.html'), 'https://www.hellofresh.co.uk/pages/referral')
    expect(result!.referralCode).toBe('ABC123XYZ')
  })

  it('extracts qualifying spend', async () => {
    const result = await extract(fixture('hellofresh-referral.html'), 'https://www.hellofresh.co.uk/pages/referral')
    expect(result!.qualifyingSpend).toMatch(/15/)
  })

  it('extracts company name via brand DB or og:site_name', async () => {
    const result = await extract(fixture('hellofresh-referral.html'), 'https://www.hellofresh.co.uk/pages/referral')
    expect(result!.companyName).toBeTruthy()
  })
})

describe('extraction fixtures: Monzo', () => {
  it('detects dual reward (both get £5)', async () => {
    const result = await extract(fixture('monzo-referral.html'), 'https://monzo.com/referral')
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('dual')
  })

  it('detects FCA signal via UK filter extraction', async () => {
    const result = await extract(fixture('monzo-referral.html'), 'https://monzo.com/referral')
    expect(result!.offerText).toMatch(/FCA/)
  })

  it('extracts referral link', async () => {
    const result = await extract(fixture('monzo-referral.html'), 'https://monzo.com/referral')
    expect(result!.referralLink).toBeTruthy()
  })
})

describe('extraction fixtures: Octopus Energy', () => {
  it('detects capped reward with max referrals', async () => {
    const result = await extract(fixture('octopus-energy-referral.html'), 'https://octopus.energy/referral')
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('capped')
  })

  it('extracts max referrals = 15', async () => {
    const result = await extract(fixture('octopus-energy-referral.html'), 'https://octopus.energy/referral')
    expect(result!.maxReferrals).toBe(15)
  })

  it('extracts £50 reward', async () => {
    const result = await extract(fixture('octopus-energy-referral.html'), 'https://octopus.energy/referral')
    expect(result!.rewardNumeric).toBe(50)
  })
})

describe('extraction fixtures: Cloudflare challenge', () => {
  it('returns null for Cloudflare challenge page', async () => {
    const result = await extract(fixture('cloudflare-challenge.html'), 'https://cloudflareprotected.co.uk/referral')
    expect(result).toBeNull()
  })
})
