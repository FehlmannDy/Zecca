// Environment -> settings and the public config served on GET /v1/config. SPEC §10.
import { DEFAULTS, type Features, type KeyStore, type Ledger, type PublicConfig } from '@zecca/contracts'

export type Env = Record<string, string | undefined>

const num = (v: string | undefined, d: number) => {
  if (v === undefined || v === '') return d
  const n = Number.parseInt(v, 10)
  return Number.isSafeInteger(n) ? n : d
}
const flag = (v: string | undefined) => v === '1' || v === 'true'

export type Settings = {
  ledgerMode: 'mock' | 'devnet'
  signerMode: 'mock' | 'privy'
  demoMode: boolean
  webOrigin: string
  welcomeCreditMinor: number
  merchantFeeBps: number
  txCapMinor: number
  dailyCapMinor: number
  tier0: { balanceCapMinor: number; txCapMinor: number; monthlySendCapMinor: number }
  paymentRequestTtlMs: number
  sessionTtlMs: number
  nonceTtlMs: number
  /** Prepares (sign-up, send, pay) per user per minute. */
  prepareRateLimitPerMin: number
  privyAppId?: string
  privyAppSecret?: string
  features: Features
  /** Validate every JSON response against its route schema (on unless NODE_ENV=production). */
  validateResponses: boolean
}

export function featuresFrom(env: Env): Features {
  return {
    // Ramp routes belong to the ramp connector (wave 2); off until it is in.
    ramp: flag(env.FEATURE_RAMP),
    withdraw: flag(env.FEATURE_WITHDRAW),
    card: flag(env.FEATURE_CARD),
    earn: flag(env.FEATURE_EARN),
    market: flag(env.FEATURE_MARKET),
    identity: flag(env.FEATURE_IDENTITY),
    proofs: flag(env.FEATURE_PROOFS),
    demoShop: flag(env.FEATURE_DEMO_SHOP ?? env.DEMO_MODE),
    passkey: flag(env.FEATURE_PASSKEY),
    googleLogin: flag(env.FEATURE_GOOGLE_LOGIN),
  }
}

export function settingsFrom(env: Env): Settings {
  return {
    ledgerMode: env.LEDGER_MODE === 'devnet' ? 'devnet' : 'mock',
    signerMode: env.SIGNER_MODE === 'privy' ? 'privy' : 'mock',
    demoMode: flag(env.DEMO_MODE),
    webOrigin: (env.WEB_ORIGIN ?? 'http://localhost:3100').replace(/\/+$/, ''),
    welcomeCreditMinor: num(env.WELCOME_CREDIT_MINOR, DEFAULTS.WELCOME_CREDIT_MINOR),
    merchantFeeBps: num(env.MERCHANT_FEE_BPS, DEFAULTS.MERCHANT_FEE_BPS),
    txCapMinor: num(env.TX_CAP_MINOR, DEFAULTS.TX_CAP_MINOR),
    dailyCapMinor: num(env.DAILY_CAP_MINOR, DEFAULTS.DAILY_CAP_MINOR),
    tier0: {
      balanceCapMinor: num(env.TIER0_BALANCE_CAP_MINOR, DEFAULTS.TIER0_BALANCE_CAP_MINOR),
      txCapMinor: num(env.TIER0_TX_CAP_MINOR, DEFAULTS.TIER0_TX_CAP_MINOR),
      monthlySendCapMinor: num(env.TIER0_MONTHLY_SEND_CAP_MINOR, DEFAULTS.TIER0_MONTHLY_SEND_CAP_MINOR),
    },
    paymentRequestTtlMs: num(env.PAYMENT_REQUEST_TTL_SECONDS, DEFAULTS.PAYMENT_REQUEST_TTL_SECONDS) * 1000,
    sessionTtlMs: num(env.SESSION_TTL_HOURS, 24 * 7) * 3_600_000,
    nonceTtlMs: 5 * 60_000,
    prepareRateLimitPerMin: num(env.PREPARE_RATE_LIMIT_PER_MIN, 30),
    privyAppId: env.PRIVY_APP_ID || undefined,
    privyAppSecret: env.PRIVY_APP_SECRET || undefined,
    features: featuresFrom(env),
    validateResponses: env.NODE_ENV !== 'production',
  }
}

/** The addresses and issuance actually in use (from the key store and the ledger when they are wired). */
export type RuntimeIds = { keystore?: KeyStore; ledger?: Ledger }

export function publicConfig(env: Env, rt: RuntimeIds = {}): PublicConfig {
  const s = settingsFrom(env)
  const addr = (role: 'sponsor' | 'issuer' | 'pool', fallback: string) =>
    rt.keystore?.hasWallet(role) ? rt.keystore.getWallet(role).address : fallback
  return {
    network: 'devnet',
    ledgerMode: s.ledgerMode,
    signerMode: s.signerMode,
    demoMode: s.demoMode,
    addresses: {
      sponsor: addr('sponsor', env.SPONSOR_ADDRESS ?? 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT'),
      issuer: addr('issuer', env.ISSUER_ADDRESS ?? 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3'),
      pool: addr('pool', env.POOL_ADDRESS ?? 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ'),
    },
    issuanceId: rt.ledger?.issuanceId ?? env.CMPT_ISSUANCE_ID ?? '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9',
    features: s.features,
    limits: { txCapMinor: s.txCapMinor, dailyCapMinor: s.dailyCapMinor, tier0: s.tier0 },
    fees: {
      merchantFeeBps: s.merchantFeeBps,
      marketSpreadBps: num(env.MARKET_SPREAD_BPS, DEFAULTS.MARKET_SPREAD_BPS),
      earnFeeBps: num(env.EARN_FEE_BPS, DEFAULTS.EARN_FEE_BPS),
      earnSwapBps: num(env.EARN_SWAP_BPS, DEFAULTS.EARN_SWAP_BPS),
    },
    welcomeCreditMinor: s.welcomeCreditMinor,
    rampSandboxScale: Math.max(1, num(env.RAMP_SANDBOX_SCALE, DEFAULTS.RAMP_SANDBOX_SCALE)),
    privyAppId: s.privyAppId,
    explorer: { devnet: 'https://devnet.xrpl.org/transactions/', testnet: 'https://testnet.xrpl.org/transactions/' },
    webOrigin: s.webOrigin,
  }
}
