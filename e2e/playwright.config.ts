import { defineConfig, devices } from '@playwright/test'

// E2E-1 (SPEC §9) and the E2E-2 feature specs. Playwright starts its own API and a production build of the web
// on their own ports, so it never disturbs a dev server on :3100/:8800.
//   npm run test:e2e                      mock ledger (every merge)
//   E2E_LEDGER=devnet npm run test:e2e    real Devnet (integration points; reads ../.env for the key store)
const API_PORT = 8801
const WEB_PORT = 3201
const devnet = process.env.E2E_LEDGER === 'devnet'
// Specs read the API origin from here (workers inherit the runner's env).
process.env.E2E_API_ORIGIN ??= `http://localhost:${API_PORT}`
const apiEnv = [
  `API_PORT=${API_PORT}`,
  `WEB_ORIGIN=http://localhost:${WEB_PORT}`,
  `LEDGER_MODE=${devnet ? 'devnet' : 'mock'}`,
  'SIGNER_MODE=mock',
  'DEMO_MODE=1',
  `DATABASE_PATH=${devnet ? './.data/e2e-devnet.sqlite' : ':memory:'}`,
  `POOL_DB_PATH=${devnet ? './.data/e2e-devnet-pool.sqlite' : ':memory:'}`,
  'MOCK_VALIDATION_DELAY_MS=300',
  'FEATURE_RAMP=1',
  'FEATURE_DEMO_SHOP=1',
  ...(process.env.E2E_FEATURES ?? '').split(',').filter(Boolean).map((f) => `FEATURE_${f.toUpperCase()}=1`),
  // Phase-2 connectors run in their test modes unless E2E_API_ENV overrides them (e.g. "EARN_MODE=live").
  ...(devnet ? [] : ['IDENTITY_MODE=mock', 'EARN_MODE=mock', 'MARKET_PRICE_SOURCE=fixture']),
  ...(process.env.E2E_API_ENV ?? '').split(' ').filter(Boolean),
].join(' ')

export default defineConfig({
  testDir: './tests',
  timeout: devnet ? 900_000 : 360_000,
  expect: { timeout: devnet ? 90_000 : 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: `test-results/run-${process.pid}`,
  use: { baseURL: `http://localhost:${WEB_PORT}`, trace: 'retain-on-failure', actionTimeout: 30_000 },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `env ${apiEnv} NODE_OPTIONS=--require=./scripts/dev/dnsfix.cjs node --env-file-if-exists=.env node_modules/tsx/dist/cli.mjs services/api/src/server.ts`,
      cwd: '..',
      url: `http://localhost:${API_PORT}/v1/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: 'pipe',
    },
    {
      command: `env NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_API_ORIGIN=http://localhost:${API_PORT} sh -c 'npx next build && npx next start --port ${WEB_PORT}'`,
      cwd: '../apps/web',
      url: `http://localhost:${WEB_PORT}/app/signup`,
      timeout: 400_000,
      reuseExistingServer: !!process.env.E2E_REUSE_WEB,
    },
  ],
})
