if (!process.env.DATABASE_URL || process.env.DATABASE_URL === 'postgresql://localhost:5432/referral_discovery') {
  process.env.DATABASE_URL = process.env.CI === 'true'
    ? 'postgresql://referralradar:referralradar@localhost:5432/referralradar_test'
    : 'postgresql://localhost:5432/referral_discovery_test'
}
process.env.EASYEARNS_API_KEY = 'test-easyearns-key-16charsmin'
process.env.ADMIN_API_KEY = 'test-admin-key-16charsminok'
process.env.GOOGLE_CSE_KEY = 'test-cse-key'
process.env.GOOGLE_CSE_ID = 'test-cse-id'
process.env.NODE_ENV = 'test'
