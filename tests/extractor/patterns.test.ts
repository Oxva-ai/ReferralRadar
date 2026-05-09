import { describe, it, expect } from 'vitest'
import { extract } from '../../src/services/extractor.js'

// Minimal valid HTML wrapper with enough text to pass the 50-char minimum
function html(body: string): string {
  const padding = ' <span>Additional page content to meet minimum text length requirement for extraction.</span>'
  return '<!DOCTYPE html><html><head><title>Test Page</title></head><body>' + body + padding + '</body></html>'
}

describe('extract: reward types', () => {
  it('detects dual reward: you get X, friend gets Y', async () => {
    const result = await extract(
      html('<p>You\'ll get £30 for each friend who opens an account and they\'ll get £10</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('dual')
    expect(result!.reward).toMatch(/30/)
    expect(result!.friendReward).toMatch(/10/)
  })

  it('detects both-get dual reward', async () => {
    const result = await extract(
      html('<p>Both get £25 when you refer a friend</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('dual')
  })

  it('detects each-get dual reward', async () => {
    const result = await extract(
      html('<p>Each receive £50 for signing up</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('dual')
  })

  it('detects per-referral flat rate', async () => {
    const result = await extract(
      html('<p>You\'ll get £20 for each referral</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('per_referral')
    expect(result!.reward).toMatch(/20/)
    expect(result!.rewardNumeric).toBe(20)
  })

  it('detects free product offer', async () => {
    const result = await extract(
      html('<p>Get a free box when you sign up</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('free_product')
    expect(result!.reward).toBeDefined()
  })

  it('detects free share offer', async () => {
    const result = await extract(
      html('<p>Get a free share worth up to £100</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(['free_share', 'free_product']).toContain(result!.rewardType)
  })

  it('detects switching bonus', async () => {
    const result = await extract(
      html('<p>Switch your bank and get £175 switching bonus</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('switching_bonus')
  })

  it('detects signup credit', async () => {
    const result = await extract(
      html('<p>Get £10 free just for joining</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    const isValidType = ['per_referral', 'signup_credit', 'dual'].includes(result!.rewardType)
    expect(isValidType).toBe(true)
  })

  it('detects capped referral', async () => {
    const result = await extract(
      html('<p>Earn up to £500 in referral bonuses</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('capped')
  })

  it('detects capped with max referrals', async () => {
    const result = await extract(
      html('<p>Earn up to £500 by referring up to 5 friends to our service</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.maxReferrals).toBe(5)
  })

  it('detects percentage offer', async () => {
    const result = await extract(
      html('<p>Get 10% cashback on your first purchase</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('percentage')
    expect(result!.rewardNumeric).toBe(10)
  })

  it('falls back to GBP fallback pattern', async () => {
    const result = await extract(
      html('<p>£15 bonus available</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardNumeric).toBe(15)
  })

  it('returns unknown for no GBP content', async () => {
    const result = await extract(
      html('<p>Welcome to our service</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.rewardType).toBe('unknown')
    expect(result!.rewardNumeric).toBeNull()
  })
})

describe('extract: company name', () => {
  it('extracts from og:site_name meta tag', async () => {
    const page = '<!DOCTYPE html><html><head><meta property="og:site_name" content="Monzo Bank"><title>Monzo - Referral</title></head><body><p>Get £5 bonus when you refer a friend to Monzo Bank today</p></body></html>'
    const result = await extract(page, 'https://monzo.com/referral')
    expect(result).not.toBeNull()
    expect(result!.companyName).toBe('Monzo')
  })

  it('falls back to title tag', async () => {
    const page = '<!DOCTYPE html><html><head><title>HelloFresh UK - Refer a Friend</title></head><body><p>Get a free food box delivered to your doorstep when you refer friends to our service</p></body></html>'
    const result = await extract(page, 'https://hellofresh.co.uk/refer')
    expect(result).not.toBeNull()
    expect(result!.companyName).toBe('HelloFresh')
  })

  it('falls back to domain name', async () => {
    const page = '<!DOCTYPE html><html><head><title>Home</title></head><body><p>£10 bonus for each friend you refer to Revolut banking app</p></body></html>'
    const result = await extract(page, 'https://www.revolut.com/referral')
    expect(result).not.toBeNull()
    expect(result!.companyName).toBe('Revolut')
  })
})

describe('extract: referral link', () => {
  it('extracts ref parameter link', async () => {
    const page = html('<a href="https://app.example.com/signup?ref=abc123">Sign up</a>')
    const result = await extract(page, 'https://example.co.uk/referral')
    expect(result).not.toBeNull()
    expect(result!.referralLink).toBeTruthy()
  })

  it('extracts referral code from text', async () => {
    const page = html('<p>Use referral code: ABC123XYZ to get started. Get £10.</p>')
    const result = await extract(page, 'https://example.co.uk/referral')
    expect(result).not.toBeNull()
    expect(result!.referralLink).toBeDefined()
  })
})

describe('extract: edge cases', () => {
  it('handles empty page gracefully', async () => {
    const result = await extract(
      '<!DOCTYPE html><html><body></body></html>',
      'https://example.co.uk',
    )
    expect(result).toBeNull()
  })

  it('detects Cloudflare challenge page', async () => {
    const result = await extract(
      html('<p>Just a moment... Enable JavaScript and cookies to continue</p>'),
      'https://example.co.uk',
    )
    expect(result).toBeNull()
  })

  it('extracts qualifying spend', async () => {
    const result = await extract(
      html('<p>Get £20. Minimum spend of £15.</p>'),
      'https://example.co.uk/referral',
    )
    expect(result).not.toBeNull()
    expect(result!.qualifyingSpend).toBeDefined()
    expect(result!.qualifyingSpend).toMatch(/15/)
  })
})

describe('extract: multi-offer splitting', () => {
  it('splits multi-offer long text', async () => {
    const longText = '1. First offer: Get £10 for each friend.\n2. Next offer: Get £20 for each friend.\n'.repeat(20)
    const page = html('<div class="content">' + longText + '</div>')
    const result = await extract(page, 'https://example.co.uk/referral')
    expect(result).not.toBeNull()
    // Multi-offer splitting should produce segments
    expect(result!.multiOfferSegments.length).toBeGreaterThanOrEqual(1)
  })
})

describe('extract: image alt text fallback', () => {
  it('detects reward from image alt text when no text reward', async () => {
    const page = '<!DOCTYPE html><html><body><p>Welcome to our referral page where you can earn rewards</p><img alt="Refer a friend and get £20 free bonus when they sign up using your code" src="/banner.jpg"></body></html>'
    const result = await extract(page, 'https://example.co.uk/referral')
    expect(result).not.toBeNull()
    // Image text fallback should detect the reward
    expect(result!.rewardNumeric).toBe(20)
  })
})
