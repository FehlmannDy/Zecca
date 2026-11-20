import { defineConfig } from 'vitest/config'

// Two projects:
//  - unit:   every fast test (pure logic + contract tests), runs on the mock ledger, no network. `npm test`.
//  - ledger: real Devnet/Testnet transactions, run serially, unsandboxed. `npm run test:ledger`.
// A test file opts into the ledger layer by its name: *.ledger.test.ts
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'services/*/src/**/*.test.ts', 'apps/web/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
          exclude: ['**/node_modules/**', '**/*.ledger.test.ts', 'apps/web/.next/**'],
          environment: 'node',
          testTimeout: 15_000,
          env: { LEDGER_MODE: 'mock', SIGNER_MODE: 'mock' },
        },
      },
      {
        test: {
          name: 'ledger',
          include: ['packages/*/src/**/*.ledger.test.ts', 'services/*/src/**/*.ledger.test.ts', 'scripts/**/*.ledger.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          testTimeout: 180_000,
          hookTimeout: 300_000,
          fileParallelism: false,
          sequence: { concurrent: false },
          env: { LEDGER_MODE: 'devnet' },
        },
      },
    ],
  },
})
