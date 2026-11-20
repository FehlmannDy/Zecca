import { defineConfig, devices } from '@playwright/test'

// E2E-1 (SPEC §9). Starts API + web itself unless E2E_BASE_URL is set.
const WEB = process.env.E2E_BASE_URL ?? 'http://localhost:3100'
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure' },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 7'] } },
  ],
})
