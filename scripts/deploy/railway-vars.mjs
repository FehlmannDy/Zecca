#!/usr/bin/env node
// Sets the API service's variables on Railway from zecca/.env and the encrypted key store, never printing a value.
// Secrets go through stdin (`railway variable set KEY --stdin`), so they never appear in a command line or a log.
// Usage (from zecca/, logged in with `railway login`, project linked):
//   node scripts/deploy/railway-vars.mjs --service zecca-api --web-origin https://<web> --public-base https://<api>
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const arg = (k) => {
  const i = process.argv.indexOf(k)
  return i > 0 ? process.argv[i + 1] : undefined
}
const service = arg('--service') ?? 'zecca-api'
const webOrigin = arg('--web-origin')
const publicBase = arg('--public-base')
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..')

const env = {}
for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const ks = path.join(root, env.KEYSTORE_PATH?.replace(/^\.\//, '') ?? '.data/keystore.enc')
if (!existsSync(ks)) throw new Error('no key store file at ' + ks)

const vars = {
  // modes
  LEDGER_MODE: 'devnet',
  SIGNER_MODE: 'privy',
  DEMO_MODE: '1',
  API_HOST: '0.0.0.0',
  NODE_ENV: 'production',
  // storage on the /data volume
  DATABASE_PATH: '/data/zecca.sqlite',
  POOL_DB_PATH: '/data/pool.sqlite',
  KEYSTORE_PATH: '/data/keystore.enc',
  KEYSTORE_B64: readFileSync(ks).toString('base64'),
  // product settings
  WELCOME_CREDIT_MINOR: env.WELCOME_CREDIT_MINOR ?? '5000',
  MERCHANT_FEE_BPS: env.MERCHANT_FEE_BPS ?? '50',
  RAMP_SANDBOX_SCALE: env.RAMP_SANDBOX_SCALE ?? '100',
  IDENTITY_MODE: env.IDENTITY_MODE ?? 'mock',
  // features (each passed its E2E-2; card waits for the Lithic webhook)
  FEATURE_RAMP: '1',
  FEATURE_DEMO_SHOP: '1',
  FEATURE_IDENTITY: '1',
  FEATURE_PROOFS: '1',
  FEATURE_EARN: '1',
  FEATURE_MARKET: '1',
  FEATURE_CARD: env.FEATURE_CARD ?? '0',
  FEATURE_GOOGLE_LOGIN: env.FEATURE_GOOGLE_LOGIN ?? '0',
  FEATURE_PASSKEY: env.FEATURE_PASSKEY ?? '0',
  // secrets copied from .env
  KEYSTORE_PASSPHRASE: env.KEYSTORE_PASSPHRASE,
  PRIVY_APP_ID: env.PRIVY_APP_ID,
  PRIVY_APP_SECRET: env.PRIVY_APP_SECRET,
  MOONPAY_PUBLISHABLE_KEY: env.MOONPAY_PUBLISHABLE_KEY,
  MOONPAY_SECRET_KEY: env.MOONPAY_SECRET_KEY,
  MOONPAY_WEBHOOK_KEY: env.MOONPAY_WEBHOOK_KEY,
  LITHIC_API_KEY: env.LITHIC_API_KEY,
  LITHIC_BASE_URL: env.LITHIC_BASE_URL,
  ...(webOrigin ? { WEB_ORIGIN: webOrigin } : {}),
  ...(publicBase ? { API_ORIGIN: publicBase, PUBLIC_WEBHOOK_BASE: publicBase } : {}),
}

let failed = 0
for (const [k, v] of Object.entries(vars)) {
  if (v === undefined || v === '') {
    console.log(`skip    ${k} (not in .env)`)
    continue
  }
  const r = spawnSync('railway', ['variable', 'set', k, '--stdin', '--skip-deploys', '--service', service], { input: v, encoding: 'utf8' })
  if (r.status === 0) console.log(`set     ${k}`)
  else {
    failed++
    // Railway's own error text, which never contains the value (it came through stdin).
    console.log(`FAILED  ${k}: ${(r.stderr || r.stdout || '').trim().split('\n').pop()}`)
  }
}
process.exit(failed ? 1 : 0)
