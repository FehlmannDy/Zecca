// M0 skeleton. Agent C owns this folder from wave 1 on and replaces it with the full API.
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { DEFAULTS, type PublicConfig } from '@zecca/contracts'

export type Env = Record<string, string | undefined>

const num = (v: string | undefined, d: number) => (v === undefined || v === '' ? d : Number.parseInt(v, 10))
const flag = (v: string | undefined) => v === '1' || v === 'true'

export function publicConfig(env: Env): PublicConfig {
  return {
    network: 'devnet',
    ledgerMode: env.LEDGER_MODE === 'devnet' ? 'devnet' : 'mock',
    signerMode: env.SIGNER_MODE === 'privy' ? 'privy' : 'mock',
    demoMode: flag(env.DEMO_MODE),
    addresses: {
      sponsor: env.SPONSOR_ADDRESS ?? 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT',
      issuer: env.ISSUER_ADDRESS ?? 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3',
      pool: env.POOL_ADDRESS ?? 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ',
    },
    issuanceId: env.CMPT_ISSUANCE_ID ?? '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9',
    features: {
      ramp: flag(env.FEATURE_RAMP ?? '1'),
      withdraw: flag(env.FEATURE_WITHDRAW),
      card: flag(env.FEATURE_CARD),
      earn: flag(env.FEATURE_EARN),
      market: flag(env.FEATURE_MARKET),
      identity: flag(env.FEATURE_IDENTITY),
      proofs: flag(env.FEATURE_PROOFS),
      demoShop: flag(env.FEATURE_DEMO_SHOP ?? env.DEMO_MODE),
      passkey: flag(env.FEATURE_PASSKEY),
      googleLogin: flag(env.FEATURE_GOOGLE_LOGIN),
    },
    limits: {
      txCapMinor: num(env.TX_CAP_MINOR, DEFAULTS.TX_CAP_MINOR),
      dailyCapMinor: num(env.DAILY_CAP_MINOR, DEFAULTS.DAILY_CAP_MINOR),
      tier0: {
        balanceCapMinor: num(env.TIER0_BALANCE_CAP_MINOR, DEFAULTS.TIER0_BALANCE_CAP_MINOR),
        txCapMinor: num(env.TIER0_TX_CAP_MINOR, DEFAULTS.TIER0_TX_CAP_MINOR),
        monthlySendCapMinor: num(env.TIER0_MONTHLY_SEND_CAP_MINOR, DEFAULTS.TIER0_MONTHLY_SEND_CAP_MINOR),
      },
    },
    fees: {
      merchantFeeBps: num(env.MERCHANT_FEE_BPS, DEFAULTS.MERCHANT_FEE_BPS),
      marketSpreadBps: num(env.MARKET_SPREAD_BPS, DEFAULTS.MARKET_SPREAD_BPS),
      earnFeeBps: num(env.EARN_FEE_BPS, DEFAULTS.EARN_FEE_BPS),
      earnSwapBps: num(env.EARN_SWAP_BPS, DEFAULTS.EARN_SWAP_BPS),
    },
    welcomeCreditMinor: num(env.WELCOME_CREDIT_MINOR, DEFAULTS.WELCOME_CREDIT_MINOR),
    rampSandboxScale: num(env.RAMP_SANDBOX_SCALE, DEFAULTS.RAMP_SANDBOX_SCALE),
    privyAppId: env.PRIVY_APP_ID,
    explorer: { devnet: 'https://devnet.xrpl.org/transactions/', testnet: 'https://testnet.xrpl.org/transactions/' },
    webOrigin: env.WEB_ORIGIN ?? 'http://localhost:3100',
  }
}

export function createApp({ env }: { env: Env }) {
  const app = new Hono()
  app.use('/v1/*', cors({ origin: env.WEB_ORIGIN ?? 'http://localhost:3100', credentials: true }))
  app.get('/v1/health', (c) => c.json({ ok: true, ledger: env.LEDGER_MODE === 'devnet' ? 'devnet' : 'mock', version: '0.1.0' }))
  app.get('/v1/config', (c) => c.json(publicConfig(env)))
  return app
}
