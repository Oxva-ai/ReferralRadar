import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { pool } from '../../src/db/pool.js'
import {
  insertReferral,
  findReferralBySourceUrl,
  queryReferrals,
  getReferralById,
  insertWorkerRun,
  completeWorkerRun,
  getHealthStats,
  insertClickEvent,
  insertImpressionEvent,
  type InsertReferral,
} from '../../src/db/queries.js'

const skipDb = process.env.INTEGRATION_TESTS_SKIP === 'true'

const testReferral: InsertReferral = {
  source_url: 'https://testbank.co.uk/refer-a-friend',
  company_name: 'Test Bank',
  reward: '£50',
  reward_numeric: 50,
  reward_type: 'per_referral',
  offer_text: 'Earn £50 for each friend you refer to Test Bank',
  currency: 'GBP',
  sources: ['serper'],
  source_count: 1,
  uk_signal_strength: 'strong',
  referral_link: 'https://testbank.co.uk/refer?code=TEST123',
}

describe.skipIf(skipDb)('queries: insert and read referrals', () => {
  let insertedId: string

  it('inserts a referral', async () => {
    const row = await insertReferral(testReferral)
    expect(row).toBeDefined()
    expect(row.id).toBeTruthy()
    expect(row.company_name).toBe('Test Bank')
    expect(row.reward_numeric).toBe(50)
    expect(row.currency).toBe('GBP')
    expect(row.domain).toBe('testbank.co.uk')
    insertedId = row.id
  })

  it('finds referral by source URL', async () => {
    const row = await findReferralBySourceUrl('https://testbank.co.uk/refer-a-friend')
    expect(row).not.toBeNull()
    expect(row!.id).toBe(insertedId)
  })

  it('finds referral by ID', async () => {
    const row = await getReferralById(insertedId)
    expect(row).not.toBeNull()
    expect(row!.company_name).toBe('Test Bank')
  })

  it('queries referrals with filters', async () => {
    const result = await queryReferrals({ limit: 10, min_score: 0, sort: 'newest' })
    expect(result.total).toBeGreaterThanOrEqual(1)
    expect(result.data.length).toBeGreaterThanOrEqual(1)
    expect(result.data[0]!.id).toBe(insertedId)
  })

  it('deduplicates by source URL', async () => {
    const row = await findReferralBySourceUrl('https://testbank.co.uk/refer-a-friend')
    expect(row).not.toBeNull()
    const row2 = await findReferralBySourceUrl('https://testbank.co.uk/refer-a-friend')
    expect(row2!.id).toBe(insertedId)
  })
})

describe.skipIf(skipDb)('queries: worker runs', () => {
  it('inserts and completes a worker run', async () => {
    const runId = await insertWorkerRun('test-worker')
    expect(runId).toBeTruthy()

    await completeWorkerRun(runId, 10, 3)

    const health = await getHealthStats()
    expect(health.workerRuns.length).toBeGreaterThanOrEqual(1)
  })
})

describe.skipIf(skipDb)('queries: click and impression tracking', () => {
  let refId: string

  beforeAll(async () => {
    const row = await insertReferral({
      source_url: 'https://clicktest.co.uk/refer',
      company_name: 'Click Test',
      reward: '£10',
      reward_numeric: 10,
      reward_type: 'per_referral',
      offer_text: 'Earn £10',
      currency: 'GBP',
      sources: ['serper'],
      uk_signal_strength: 'moderate',
    })
    refId = row.id
  })

  it('records a click', async () => {
    const recorded = await insertClickEvent(refId)
    expect(recorded).toBe(true)
  })

  it('deduplicates clicks within 1 day', async () => {
    const recorded = await insertClickEvent(refId)
    expect(recorded).toBe(false)
  })

  it('records an impression', async () => {
    const recorded = await insertImpressionEvent(refId)
    expect(recorded).toBe(true)
  })

  afterAll(async () => {
    await pool.query('DELETE FROM click_events WHERE referral_id = $1', [refId])
    await pool.query('DELETE FROM impression_events WHERE referral_id = $1', [refId])
  })
})
