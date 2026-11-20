// Creates zecca/.env (mode 0600) if missing, or adds the keys it lacks. Never prints a value, only key names.
// Run from zecca/: node node_modules/tsx/dist/cli.mjs scripts/setup-env.ts
import { chmodSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { keyStorePath, writeFileAtomic } from '@zecca/keystore'
import { envValues, parseEnv } from './lib/env-file'
import { generatePassphrase, planEnv } from './lib/setup-env'

const ZECCA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(ZECCA, '..')
const envPath = path.join(ZECCA, '.env')
const sourcePaths = {
  privy: path.join(ROOT, 'privy-xrpl-probe/.env'),
  moonpay: path.join(ROOT, 'moonpay-ramp/.env'),
  card: path.join(ROOT, 'card-issuer/.env'),
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : null)

const current = read(envPath)
const sources = { privy: read(sourcePaths.privy), moonpay: read(sourcePaths.moonpay), card: read(sourcePaths.card) }
const plan = planEnv({ current, sources, newPassphrase: generatePassphrase })

if (plan.passphraseGenerated) {
  const ks = keyStorePath(envValues(parseEnv(plan.text)))
  if (existsSync(ks)) {
    console.error(`setup-env: ${path.relative(ZECCA, ks)} exists but .env has no KEYSTORE_PASSPHRASE; a new passphrase could not open it.`)
    console.error('setup-env: put the old passphrase back in .env, or move the key store away and run import-keys again. Nothing written.')
    process.exit(1)
  }
}

if (plan.text !== current) writeFileAtomic(envPath, plan.text)
else chmodSync(envPath, 0o600)

for (const [name, p] of Object.entries(sourcePaths)) if (!sources[name as keyof typeof sources]) console.log(`source not found: ${path.relative(ROOT, p)}`)
console.log(`${current === null ? 'created' : plan.text === current ? 'unchanged' : 'updated'}: ${path.relative(process.cwd(), envPath) || '.env'} (mode 600)`)
if (plan.added.length) console.log(`added: ${plan.added.join(', ')}`)
if (plan.filled.length) console.log(`filled (were empty): ${plan.filled.join(', ')}`)
if (plan.kept.length) console.log(`kept: ${plan.kept.join(', ')}`)
if (plan.missing.length) console.log(`missing (no source value): ${plan.missing.join(', ')}`)
