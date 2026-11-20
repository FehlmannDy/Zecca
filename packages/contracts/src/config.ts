import { z } from 'zod'
import { BasisPoints, IssuanceId, Minor, Network, XrplAddress } from './primitives'

/** Feature flags served in GET /v1/config. The UI hides what is off. */
export const FeatureName = z.enum([
  'ramp',
  'withdraw',
  'card',
  'earn',
  'market',
  'identity',
  'proofs',
  'demoShop',
  'passkey',
  'googleLogin',
])
export type FeatureName = z.infer<typeof FeatureName>

export const Features = z.record(FeatureName, z.boolean())
export type Features = z.infer<typeof Features>

export const Limits = z.object({
  /** Cap per transaction once verified (tier 1). */
  txCapMinor: Minor,
  dailyCapMinor: Minor,
  tier0: z.object({
    balanceCapMinor: Minor,
    txCapMinor: Minor,
    monthlySendCapMinor: Minor,
  }),
})
export type Limits = z.infer<typeof Limits>

export const Fees = z.object({
  merchantFeeBps: BasisPoints,
  marketSpreadBps: BasisPoints,
  earnFeeBps: BasisPoints,
  earnSwapBps: BasisPoints,
})
export type Fees = z.infer<typeof Fees>

export const PublicConfig = z.object({
  network: Network,
  ledgerMode: z.enum(['mock', 'devnet']),
  signerMode: z.enum(['mock', 'privy']),
  demoMode: z.boolean(),
  addresses: z.object({ sponsor: XrplAddress, issuer: XrplAddress, pool: XrplAddress }),
  issuanceId: IssuanceId,
  features: Features,
  limits: Limits,
  fees: Fees,
  welcomeCreditMinor: Minor,
  /** Multiplier applied to sandbox top-ups (1 = none). The top-up screen says "Sandbox" when not 1. */
  rampSandboxScale: z.number().int().positive(),
  privyAppId: z.string().optional(),
  /** Explorer base for transaction links, e.g. https://devnet.xrpl.org/transactions/ */
  explorer: z.object({ devnet: z.string().url(), testnet: z.string().url() }),
  webOrigin: z.string().url(),
})
export type PublicConfig = z.infer<typeof PublicConfig>

/** Defaults from SPEC §10. */
export const DEFAULTS = {
  WELCOME_CREDIT_MINOR: 5000,
  MERCHANT_FEE_BPS: 50,
  TX_CAP_MINOR: 500_000,
  DAILY_CAP_MINOR: 1_000_000,
  TIER0_BALANCE_CAP_MINOR: 15_000,
  TIER0_TX_CAP_MINOR: 5_000,
  TIER0_MONTHLY_SEND_CAP_MINOR: 15_000,
  MARKET_SPREAD_BPS: 100,
  EARN_FEE_BPS: 1000,
  EARN_SWAP_BPS: 30,
  RAMP_SANDBOX_SCALE: 1,
  PAYMENT_REQUEST_TTL_SECONDS: 600,
  LLS_WINDOW: 150,
} as const
