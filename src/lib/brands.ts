import { pool } from '../db/pool.js'
import { logger } from '../logger.js'

export interface UkBrand {
  name: string
  domain: string
  category: string
  likelyReferralPage?: string
}

const FALLBACK_BRANDS: UkBrand[] = [
  { name: 'Monzo', domain: 'monzo.com', category: 'banking' },
  { name: 'Revolut', domain: 'revolut.com', category: 'banking' },
  { name: 'HelloFresh', domain: 'hellofresh.co.uk', category: 'food' },
  { name: 'Starling Bank', domain: 'starlingbank.com', category: 'banking' },
  { name: 'Octopus Energy', domain: 'octopus.energy', category: 'utilities' },
  { name: 'Freetrade', domain: 'freetrade.io', category: 'investing' },
  { name: 'Gousto', domain: 'gousto.co.uk', category: 'food' },
  { name: 'Deliveroo', domain: 'deliveroo.co.uk', category: 'food' },
  { name: 'Curve', domain: 'curve.com', category: 'finance' },
  { name: 'Ecotricity', domain: 'ecotricity.co.uk', category: 'utilities' },
  { name: 'Just Eat', domain: 'just-eat.co.uk', category: 'food' },
  { name: 'Trading 212', domain: 'trading212.com', category: 'investing' },
  { name: 'PensionBee', domain: 'pensionbee.com', category: 'investing' },
  { name: 'Moneybox', domain: 'moneyboxapp.com', category: 'investing' },
  { name: 'Chase UK', domain: 'chase.co.uk', category: 'banking' },
  { name: 'E.ON Next', domain: 'eonnext.com', category: 'utilities' },
  { name: 'Trainline', domain: 'trainline.com', category: 'travel' },
  { name: 'Vinted', domain: 'vinted.co.uk', category: 'shopping' },
  { name: 'Currensea', domain: 'currensea.com', category: 'finance' },
  { name: 'Klarna', domain: 'klarna.com', category: 'finance' },
]

function applyBrands(brands: UkBrand[]): void {
  const newByDomain: Record<string, UkBrand> = {}
  for (const brand of brands) {
    newByDomain[brand.domain.toLowerCase()] = brand
    newByDomain[`www.${brand.domain.toLowerCase()}`] = brand
  }
  _brands.length = 0
  _brands.push(...brands)
  Object.keys(_byDomain).forEach(k => delete _byDomain[k])
  Object.assign(_byDomain, newByDomain)
}

const _brands: UkBrand[] = []
const _byDomain: Record<string, UkBrand> = {}
let loadPromise: Promise<void> | null = null

async function loadBrands(): Promise<void> {
  try {
    const result = await pool.query<Record<string, unknown>>(
      'SELECT name, domain, category, likely_referral_page FROM brands WHERE is_active = true ORDER BY name',
    )

    const newBrands: UkBrand[] = result.rows.map(r => ({
      name: r.name as string,
      domain: r.domain as string,
      category: r.category as string,
      ...((r.likely_referral_page as string | null) ? { likelyReferralPage: r.likely_referral_page as string } : {}),
    }))

    if (newBrands.length > 0) {
      applyBrands(newBrands)
    } else {
      applyBrands(FALLBACK_BRANDS)
    }
  } catch (err) {
    logger.warn({ err }, 'brand DB load failed, using fallback brands')
    applyBrands(FALLBACK_BRANDS)
  }
}

function ensureLoaded(): void {
  if (!loadPromise) {
    applyBrands(FALLBACK_BRANDS)
    loadPromise = loadBrands()
  }
}

ensureLoaded()

export const UK_BRANDS: UkBrand[] = new Proxy(_brands, {
  get(target, prop: string | symbol) {
    return target[prop as keyof typeof target]
  },
})

export const BRAND_BY_DOMAIN: Record<string, UkBrand> = new Proxy(_byDomain, {
  get(target, prop: string | symbol) {
    return target[prop as keyof typeof target]
  },
})

export function getCompanyName(domain: string): string | null {
  return _byDomain[domain.toLowerCase()]?.name ?? null
}

export function getCategory(domain: string): string | null {
  return _byDomain[domain.toLowerCase()]?.category ?? null
}

export function getBrandSearchQueries(): Array<{ brand: UkBrand; query: string }> {
  if (_brands.length === 0) return []
  return _brands.map(brand => ({
    brand,
    query: `"${brand.name}" referral OR "refer a friend" OR "invite friends"`,
  }))
}

export function reloadBrands(): void {
  loadPromise = null
  ensureLoaded()
}
