import { describe, expect, it } from 'vitest'
import { envValues, parseEnv } from './env-file'
import { ENV_VARS, renderEnvExample } from './env-vars'

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
    expect(Object.keys(active).sort()).toEqual(ENV_VARS.filter((v) => v.default === undefined).map((v) => v.name).sort())
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
})
