import { defineConfig } from '@playwright/test'
import dotenv from 'dotenv'

dotenv.config()

// E2E tests create real shops, bookings, and accounts. They must NEVER
// default to production — the target is always an explicit choice.
if (!process.env.E2E_BASE_URL) {
  throw new Error(
    'E2E_BASE_URL is not set. Point it at a staging/preview deployment in .env ' +
      '(see .env.example). Refusing to run E2E tests without an explicit target.'
  )
}
if (/(^|\.)pivotparlor\.com/.test(new URL(process.env.E2E_BASE_URL).hostname)) {
  console.warn(
    `⚠ E2E_BASE_URL points at ${process.env.E2E_BASE_URL} — that looks like production. ` +
      'E2E fixtures are disabled there (E2E_FIXTURES unset), so fixture-dependent tests will fail.'
  )
}

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL,
    // Marks browser traffic as E2E so the staging Worker (E2E_FIXTURES=true)
    // exempts these requests from the login brute-force brake. Ignored by
    // production (E2E_FIXTURES unset), so real users are always rate-limited.
    extraHTTPHeaders: { 'X-E2E-Test-Mock': '1' },
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
})