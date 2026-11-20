// What scripts/setup-env.ts writes into zecca/.env. Pure: file reading and writing live in the CLI.
import { randomBytes } from 'node:crypto'
import { envValues, mergeEnv, parseEnv, serializeEnv } from './env-file'

/** Keys copied, under the same names, from the probe folders' .env files. */
export const COPY_FROM = {
  privy: ['PRIVY_APP_ID', 'PRIVY_APP_SECRET'],
  moonpay: ['MOONPAY_PUBLISHABLE_KEY', 'MOONPAY_SECRET_KEY', 'MOONPAY_WEBHOOK_KEY'],
  card: ['LITHIC_API_KEY', 'LITHIC_BASE_URL'],
} as const
export type EnvSource = keyof typeof COPY_FROM

/** Non-secret defaults for local work. */
export const LOCAL_DEFAULTS: Record<string, string> = {
  LEDGER_MODE: 'mock',
  SIGNER_MODE: 'mock',
  DEMO_MODE: '1',
  WEB_ORIGIN: 'http://localhost:3100',
  API_ORIGIN: 'http://localhost:8800',
  NEXT_PUBLIC_API_ORIGIN: 'http://localhost:8800',
  WELCOME_CREDIT_MINOR: '5000',
  RAMP_SANDBOX_SCALE: '100',
  MERCHANT_FEE_BPS: '50',
}

const HEADER = '# Zecca local environment (created by scripts/setup-env.ts). Never commit this file.\n'

export const generatePassphrase = () => randomBytes(32).toString('base64url')

export type EnvPlan = {
  text: string
  added: string[]
  filled: string[]
  kept: string[]
  /** Keys to copy that neither the current .env nor their source file has. */
  missing: string[]
  passphraseGenerated: boolean
}

export function planEnv(input: {
  current: string | null
  sources: Partial<Record<EnvSource, string | null>>
  newPassphrase: () => string
}): EnvPlan {
  const doc = parseEnv(input.current ?? HEADER)
  const have = envValues(doc)
  const values: Record<string, string> = {}
  const passphraseGenerated = !have.KEYSTORE_PASSPHRASE
  values.KEYSTORE_PASSPHRASE = have.KEYSTORE_PASSPHRASE || input.newPassphrase()
  values.KEYSTORE_PATH = './.data/keystore.enc'
  const missing: string[] = []
  for (const [source, keys] of Object.entries(COPY_FROM) as [EnvSource, readonly string[]][]) {
    const text = input.sources[source]
    const from = text ? envValues(parseEnv(text)) : {}
    for (const k of keys) {
      if (from[k]) values[k] = from[k]
      else if (!have[k]) missing.push(k)
    }
  }
  Object.assign(values, LOCAL_DEFAULTS)
  const r = mergeEnv(doc, values)
  return { text: serializeEnv(r.doc), added: r.added, filled: r.filled, kept: r.kept, missing, passphraseGenerated }
}
