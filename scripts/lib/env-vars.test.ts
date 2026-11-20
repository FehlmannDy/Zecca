import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS } from '@zecca/contracts'
import { describe, expect, it } from 'vitest'
import { featuresFrom, settingsFrom } from '../../services/api/src/config'
import { envValues, parseEnv } from './env-file'
import { ENV_VARS, renderEnvExample } from './env-vars'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Names read as env.X or env['X'] (process.env, deps.env, ...) in services/, packages/ and scripts/; tests and test helpers left out. */
function envNamesReadByCode(): Map<string, string> {
  const found = new Map<string, string>()
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!['node_modules', 'testing', 'fixtures', '.next', 'dist'].includes(e.name)) walk(p)
      } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        for (const m of readFileSync(p, 'utf8').matchAll(/\benv(?:\.([A-Z][A-Z0-9_]*)\b|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g))
          found.set((m[1] ?? m[2])!, path.relative(REPO, p))
      }
    }
  }
  for (const d of ['services', 'packages', 'scripts']) walk(path.join(REPO, d))
  return found
}
const byName = (n: string) => ENV_VARS.find((v) => v.name === n)

const SPEC_10 = [
  'LEDGER_MODE', 'SIGNER_MODE', 'IDENTITY_MODE', 'DEMO_MODE',
  'WEB_ORIGIN', 'API_ORIGIN', 'PUBLIC_WEBHOOK_BASE',
  'KEYSTORE_PATH', 'KEYSTORE_PASSPHRASE',
  'PRIVY_APP_ID', 'PRIVY_APP_SECRET',
  'MOONPAY_PUBLISHABLE_KEY', 'MOONPAY_SECRET_KEY', 'MOONPAY_WEBHOOK_KEY',
  'RAMP_SANDBOX_SCALE', 'LITHIC_API_KEY', 'LITHIC_BASE_URL',
  'WELCOME_CREDIT_MINOR', 'MERCHANT_FEE_BPS', 'TX_CAP_MINOR',
  'TIER0_BALANCE_CAP_MINOR', 'TIER0_TX_CAP_MINOR', 'TIER0_MONTHLY_SEND_CAP_MINOR',
  'MARKET_SPREAD_BPS', 'EARN_FEE_BPS', 'EARN_SWAP_BPS',
  'FEATURE_CARD', 'FEATURE_EARN', 'FEATURE_MARKET', 'FEATURE_IDENTITY', 'FEATURE_PROOFS', 'FEATURE_WITHDRAW',
]
const EXTRA = ['NEXT_PUBLIC_API_ORIGIN', 'API_PORT', 'CMPT_ISSUANCE_ID', 'FEATURE_RAMP', 'FEATURE_DEMO_SHOP', 'FEATURE_PASSKEY', 'FEATURE_GOOGLE_LOGIN']

describe('env vars list', () => {
  it('lists every SPEC §10 variable and the build extras, once each, with a comment', () => {
    const names = ENV_VARS.map((v) => v.name)
    for (const n of [...SPEC_10, ...EXTRA]) expect(names).toContain(n)
    expect(new Set(names).size).toBe(names.length)
    for (const v of ENV_VARS) {
      expect(v.comment.length).toBeGreaterThan(5)
      expect(v.comment).not.toContain('\n')
    }
  })

  it('renders .env.example with placeholders only: no default = empty, a default = commented out', () => {
    const text = renderEnvExample()
    const active = envValues(parseEnv(text))
    // the only uncommented lines are the variables without a default, all empty; every secret is one of them
    expect(Object.keys(active).sort()).toEqual(ENV_VARS.filter((v) => v.default === undefined && !v.optional).map((v) => v.name).sort())
    for (const v of ENV_VARS.filter((x) => x.secret)) expect(v.default).toBeUndefined()
    for (const value of Object.values(active)) expect(value).toBe('')
    for (const v of ENV_VARS) expect(text).toContain(v.name)
    for (const n of ['KEYSTORE_PASSPHRASE', 'PRIVY_APP_SECRET', 'MOONPAY_SECRET_KEY', 'MOONPAY_WEBHOOK_KEY', 'LITHIC_API_KEY']) expect(active[n]).toBe('')
    expect(text).not.toMatch(/\bs[1-9A-HJ-NP-Za-km-z]{24,}\b/)
    expect(text).not.toMatch(/(sk|pk|wk)_(test|live)_[A-Za-z0-9]/)
    expect(text).not.toMatch(/trycloudflare\.com/)
    expect(text.endsWith('\n')).toBe(true)
  })

  it('documents the defaults as commented examples', () => {
    const text = renderEnvExample()
    expect(text).toContain('# LEDGER_MODE=mock')
    expect(text).toContain('# WEB_ORIGIN=http://localhost:3100')
    expect(text).toContain('# MERCHANT_FEE_BPS=50')
  })

  it('lists every variable the code reads (services/, packages/, scripts/)', () => {
    const listed = new Set(ENV_VARS.map((v) => v.name))
    const missing = [...envNamesReadByCode()].filter(([n]) => !listed.has(n)).map(([n, file]) => `${n} (${file})`)
    expect(missing, 'add these to scripts/lib/env-vars.ts').toEqual([])
  })

  it('states the defaults the API applies when a variable is unset', () => {
    const features = featuresFrom({}) as unknown as Record<string, boolean>
    for (const v of ENV_VARS.filter((x) => x.name.startsWith('FEATURE_') && x.default !== undefined)) {
      const key = v.name.slice('FEATURE_'.length).toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
      expect(features[key], v.name).toBe(v.default === '1')
    }
    const s = settingsFrom({})
    const num = (n: string) => Number(byName(n)?.default)
    expect(num('SESSION_TTL_HOURS') * 3_600_000).toBe(s.sessionTtlMs)
    expect(num('PREPARE_RATE_LIMIT_PER_MIN')).toBe(s.prepareRateLimitPerMin)
    expect(num('PAYMENT_REQUEST_TTL_SECONDS') * 1000).toBe(s.paymentRequestTtlMs)
    expect(num('PAYMENT_REQUEST_TTL_SECONDS')).toBe(DEFAULTS.PAYMENT_REQUEST_TTL_SECONDS)
    expect(num('WELCOME_CREDIT_MINOR')).toBe(s.welcomeCreditMinor)
    expect(num('DAILY_CAP_MINOR')).toBe(s.dailyCapMinor)
    expect(byName('WEB_ORIGIN')?.default).toBe(s.webOrigin)
    expect(byName('DEMO_MODE')?.default === '1').toBe(s.demoMode)
  })

  it('writes a variable whose unset value means a fallback as a commented line with no value', () => {
    const text = renderEnvExample()
    // FEATURE_DEMO_SHOP unset follows DEMO_MODE; an empty FEATURE_DEMO_SHOP= would force it off.
    for (const n of ['FEATURE_DEMO_SHOP', 'PORT', 'DATABASE_PATH', 'XRPL_DEVNET_URL', 'NODE_ENV']) {
      expect(byName(n), n).toMatchObject({ optional: true })
      expect(byName(n)?.default, n).toBeUndefined()
      expect(text.split('\n'), n).toContain(`# ${n}=`)
      expect(envValues(parseEnv(text))[n], n).toBeUndefined()
    }
    expect(text).toContain('# FEATURE_RAMP=0')
  })
})
