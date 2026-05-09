import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/helpers/setup.ts'],
    globalSetup: ['./tests/helpers/global-setup.ts'],
    testTimeout: 15_000,
    include: ['tests/integration/**/*.test.ts'],
  },
})
