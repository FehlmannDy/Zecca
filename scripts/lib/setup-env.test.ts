import { describe, expect, it } from 'vitest'
import { envValues, parseEnv } from './env-file'
import { generatePassphrase, planEnv } from './setup-env'

const PRIVY = 'PRIVY_APP_ID=fake-app-id\nPRIVY_APP_SECRET=fake-privy-secret\nPRIVY_JWKS_URL=https://example.invalid/jwks\n'
const MOONPAY = 'MOONPAY_PUBLISHABLE_KEY=fake_pk\nMOONPAY_SECRET_KEY=fake_sk\nMOONPAY_WEBHOOK_KEY=fake_wk\n'
const CARD = 'LITHIC_API_KEY=fake-lithic\nLITHIC_BASE_URL=https://sandbox.lithic.com\nADMIN_TOKEN=not-copied\nPORT=3001\n'
const PASS = 'fake-generated-passphrase-0123456789'

describe('setup-env plan', () => {
  it('creates a full .env from the three probe files and the defaults', () => {
    const r = planEnv({ current: null, sources: { privy: PRIVY, moonpay: MOONPAY, card: CARD }, newPassphrase: () => PASS })
    const v = envValues(parseEnv(r.text))
    expect(v).toMatchObject({
      KEYSTORE_PASSPHRASE: PASS,
      KEYSTORE_PATH: './.data/keystore.enc',
      PRIVY_APP_ID: 'fake-app-id',
      PRIVY_APP_SECRET: 'fake-privy-secret',
      MOONPAY_PUBLISHABLE_KEY: 'fake_pk',
      MOONPAY_SECRET_KEY: 'fake_sk',
      MOONPAY_WEBHOOK_KEY: 'fake_wk',
      LITHIC_API_KEY: 'fake-lithic',
      LITHIC_BASE_URL: 'https://sandbox.lithic.com',
      LEDGER_MODE: 'mock',
      SIGNER_MODE: 'mock',
      DEMO_MODE: '1',
      WEB_ORIGIN: 'http://localhost:3100',
      API_ORIGIN: 'http://localhost:8800',
      NEXT_PUBLIC_API_ORIGIN: 'http://localhost:8800',
      WELCOME_CREDIT_MINOR: '5000',
      RAMP_SANDBOX_SCALE: '100',
      MERCHANT_FEE_BPS: '50',
    })
    // only the named keys are copied from the probe files
    expect(v.PRIVY_JWKS_URL).toBeUndefined()
    expect(v.ADMIN_TOKEN).toBeUndefined()
    expect(v.PORT).toBeUndefined()
    expect(r.missing).toEqual([])
    expect(r.added).toContain('KEYSTORE_PASSPHRASE')
    expect(r.text.startsWith('#')).toBe(true)
    expect(r.passphraseGenerated).toBe(true)
  })

  it('on an existing .env only adds what is missing and keeps the passphrase', () => {
    const current = '# mine\nKEYSTORE_PASSPHRASE=existing-passphrase-0123456789\nLEDGER_MODE=devnet\nPRIVY_APP_SECRET=\n'
    let called = 0
    const r = planEnv({ current, sources: { privy: PRIVY, moonpay: null, card: CARD }, newPassphrase: () => (called++, PASS) })
    const v = envValues(parseEnv(r.text))
    expect(called).toBe(0)
    expect(r.passphraseGenerated).toBe(false)
    expect(v.KEYSTORE_PASSPHRASE).toBe('existing-passphrase-0123456789')
    expect(v.LEDGER_MODE).toBe('devnet')
    expect(v.PRIVY_APP_SECRET).toBe('fake-privy-secret')
    expect(r.kept).toEqual(expect.arrayContaining(['KEYSTORE_PASSPHRASE', 'LEDGER_MODE']))
    expect(r.filled).toEqual(['PRIVY_APP_SECRET'])
    expect(r.missing).toEqual(['MOONPAY_PUBLISHABLE_KEY', 'MOONPAY_SECRET_KEY', 'MOONPAY_WEBHOOK_KEY'])
    expect(r.text.startsWith('# mine\n')).toBe(true)
  })

  it('is idempotent', () => {
    const first = planEnv({ current: null, sources: { privy: PRIVY, moonpay: MOONPAY, card: CARD }, newPassphrase: () => PASS })
    const second = planEnv({ current: first.text, sources: { privy: PRIVY, moonpay: MOONPAY, card: CARD }, newPassphrase: () => 'other-passphrase-0123456789' })
    expect(second.text).toBe(first.text)
    expect(second.added).toEqual([])
    expect(second.filled).toEqual([])
  })

  it('reports keys whose source is empty as missing', () => {
    const r = planEnv({ current: null, sources: { privy: 'PRIVY_APP_ID=\n', moonpay: MOONPAY, card: CARD }, newPassphrase: () => PASS })
    expect(r.missing).toEqual(['PRIVY_APP_ID', 'PRIVY_APP_SECRET'])
    expect(envValues(parseEnv(r.text)).PRIVY_APP_ID).toBeUndefined()
  })

  it('generates a 32-byte base64url passphrase', () => {
    const p = generatePassphrase()
    expect(p).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(generatePassphrase()).not.toBe(p)
  })
})
