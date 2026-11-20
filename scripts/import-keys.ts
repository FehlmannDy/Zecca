// Imports the existing Devnet keys into the Zecca key store (KEYSTORE_PATH, KEYSTORE_PASSPHRASE from zecca/.env).
// Read-only on the probe folders. Prints role names and addresses only. Safe to run twice.
// Run from zecca/: node node_modules/tsx/dist/cli.mjs scripts/import-keys.ts
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyStorePath, openKeyStoreFromEnv } from '@zecca/keystore'
import { formatReport, importKeys } from './lib/import-keys'

const ZECCA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(ZECCA, '..')
const envFile = path.join(ZECCA, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)

try {
  const keystore = openKeyStoreFromEnv(process.env)
  const report = importKeys({
    keystore,
    probeStatePath: path.join(ROOT, 'privy-xrpl-probe/web/state.json'),
    cardStatePath: path.join(ROOT, 'card-issuer/data/xrpl-state.json'),
  })
  console.log(formatReport(report))
  console.log(`key store: ${path.relative(ZECCA, keyStorePath(process.env))}`)
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}
