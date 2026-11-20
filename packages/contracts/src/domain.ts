import { z } from 'zod'
import { BasisPoints, Handle, Id, IsoTime, Minor, Network, PositiveMinor, TxHash, XrplAddress } from './primitives'

// ---------- people ----------
export const Role = z.enum(['user', 'merchant'])
export type Role = z.infer<typeof Role>

export const Tier = z.union([z.literal(0), z.literal(1)])
export type Tier = z.infer<typeof Tier>

export const MerchantInfo = z.object({ businessName: z.string().min(1).max(60), feeBps: BasisPoints })

export const User = z.object({
  id: Id,
  role: z.array(Role).min(1),
  handle: Handle,
  displayName: z.string().min(1).max(60),
  address: XrplAddress,
  email: z.string().email().optional(),
  phone: z.string().min(4).max(20).optional(),
  tier: Tier,
  createdAt: IsoTime,
  merchant: MerchantInfo.optional(),
})
export type User = z.infer<typeof User>

export const PublicProfile = z.object({
  id: Id,
  handle: Handle,
  displayName: z.string(),
  isMerchant: z.boolean(),
})
export type PublicProfile = z.infer<typeof PublicProfile>

// ---------- money ----------
export const Balance = z.object({
  /** Spendable now. */
  availableMinor: Minor,
  /** Received, payout or merge still in flight. */
  pendingMinor: Minor,
  cardMinor: Minor.optional(),
  updatedAt: IsoTime,
})
export type Balance = z.infer<typeof Balance>

// ---------- prepared transactions ----------
export const TxKind = z.enum([
  'onboarding',
  'send',
  'merge_inbox',
  'delegate',
  'credential_accept',
  'market_authorize',
  'market_sell',
  'earn_deposit',
])
export type TxKind = z.infer<typeof TxKind>

/** An unsigned XRPL transaction (tx JSON), fully filled by the API. */
export const TxJson = z.looseObject({ TransactionType: z.string(), Account: XrplAddress })
export type TxJson = z.infer<typeof TxJson>

export const PreparedTx = z.object({
  prepareId: Id,
  kind: TxKind,
  tx: TxJson,
  expiresAt: IsoTime,
  /** Network the tx must be submitted to. Absent means devnet. */
  network: Network.optional(),
})
export type PreparedTx = z.infer<typeof PreparedTx>

// ---------- intents ----------
export const IntentKind = z.enum(['p2p', 'merchant', 'card_load', 'earn_deposit', 'market_buy', 'withdraw'])
export type IntentKind = z.infer<typeof IntentKind>

export const IntentStatus = z.enum(['created', 'submitted', 'received', 'paid_out', 'failed', 'expired'])
export type IntentStatus = z.infer<typeof IntentStatus>

export const Failure = z.object({ code: z.string(), message: z.string() })

export const Intent = z.object({
  id: Id,
  kind: IntentKind,
  status: IntentStatus,
  fromUserId: Id,
  toUserId: Id.optional(),
  amountMinor: PositiveMinor,
  feeMinor: Minor,
  note: z.string().max(140).optional(),
  paymentRequestId: Id.optional(),
  depositTxHash: TxHash.optional(),
  payoutTxHash: TxHash.optional(),
  failure: Failure.optional(),
  createdAt: IsoTime,
  updatedAt: IsoTime,
})
export type Intent = z.infer<typeof Intent>

// ---------- payment requests ----------
export const PaymentRequestStatus = z.enum(['created', 'opened', 'paid', 'expired', 'cancelled'])
export type PaymentRequestStatus = z.infer<typeof PaymentRequestStatus>

export const PaymentRequest = z.object({
  id: Id,
  merchantId: Id,
  merchantName: z.string(),
  amountMinor: PositiveMinor,
  reference: z.string().max(60).optional(),
  status: PaymentRequestStatus,
  /** https://<web>/pay/<id> */
  url: z.string().url(),
  expiresAt: IsoTime,
  paidAt: IsoTime.optional(),
  intentId: Id.optional(),
})
export type PaymentRequest = z.infer<typeof PaymentRequest>

// ---------- receipts (demo shop, card) ----------
export const ReceiptLine = z.object({ name: z.string(), qty: z.number().int().positive(), unitMinor: PositiveMinor })
export const Receipt = z.object({
  orderNumber: z.string(),
  shopName: z.string(),
  items: z.array(ReceiptLine),
  amountMinor: PositiveMinor,
  method: z.enum(['zecca', 'card']),
  cardLast4: z.string().regex(/^\d{4}$/).optional(),
  status: z.enum(['authorised', 'completed', 'declined']),
  at: IsoTime,
  reference: z.string(),
})
export type Receipt = z.infer<typeof Receipt>

// ---------- activity ----------
export const ActivityKind = z.union([IntentKind, z.enum(['topup', 'welcome'])])
export type ActivityKind = z.infer<typeof ActivityKind>

export const ActivityLedger = z.object({
  depositTxHash: TxHash.optional(),
  payoutTxHash: TxHash.optional(),
  network: Network,
  /** First bytes of the on-ledger ciphertext of the amount, hex, for the "What the ledger shows" panel. */
  ciphertextPreview: z.string().optional(),
})

export const Activity = z.object({
  id: Id,
  intentId: Id,
  direction: z.enum(['in', 'out']),
  kind: ActivityKind,
  counterparty: PublicProfile.optional(),
  amountMinor: Minor,
  feeMinor: Minor,
  status: z.enum(['pending', 'done', 'failed']),
  note: z.string().optional(),
  at: IsoTime,
  ledger: ActivityLedger,
  /** Present for purchases (demo shop, card): the receipt shown in the activity detail. */
  receipt: Receipt.optional(),
})
export type Activity = z.infer<typeof Activity>

// ---------- merchant ----------
export const Sale = z.object({
  id: Id,
  paymentRequestId: Id,
  amountMinor: PositiveMinor,
  feeMinor: Minor,
  netMinor: Minor,
  payer: PublicProfile.optional(),
  reference: z.string().optional(),
  paidAt: IsoTime,
  payoutStatus: z.enum(['pending', 'done']),
})
export type Sale = z.infer<typeof Sale>

export const SalesTotals = z.object({ grossMinor: Minor, feeMinor: Minor, netMinor: Minor, count: z.number().int().nonnegative() })
export type SalesTotals = z.infer<typeof SalesTotals>

// ---------- phase 2: card ----------
export const CardState = z.enum(['OPEN', 'PAUSED', 'CLOSED'])
export const Card = z.object({
  id: Id,
  last4: z.string().regex(/^\d{4}$/),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int().min(2024).max(2100),
  state: CardState,
  holderName: z.string().optional(),
})
export type Card = z.infer<typeof Card>

export const CardAuthorization = z.object({
  id: Id,
  amountMinor: PositiveMinor,
  merchant: z.string(),
  approved: z.boolean(),
  status: z.enum(['authorised', 'completed', 'declined', 'voided', 'refunded']),
  declineReason: z.string().optional(),
  at: IsoTime,
})
export type CardAuthorization = z.infer<typeof CardAuthorization>

export const CardSecret = z.object({
  pan: z.string().regex(/^\d{12,19}$/),
  cvc: z.string().regex(/^\d{3,4}$/),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int(),
})
export type CardSecret = z.infer<typeof CardSecret>

// ---------- phase 2: earn ----------
export const EarnPosition = z.object({
  depositedDrops: z.number().int().nonnegative(),
  valueDrops: z.number().int().nonnegative(),
  valueUsdMinor: Minor,
  apyPct: z.number().optional(),
  history: z.array(z.object({ at: IsoTime, valueDrops: z.number().int().nonnegative() })),
  pendingWithdrawal: z.object({ amountDrops: z.number().int().positive(), claimableAt: IsoTime }).optional(),
  status: z.enum(['none', 'funding', 'opening', 'active']),
})
export type EarnPosition = z.infer<typeof EarnPosition>

// ---------- phase 2: identity ----------
export const VerifiedIdentity = z.object({
  givenName: z.string(),
  familyName: z.string(),
  birthDate: z.string(),
  over18: z.boolean(),
})
export type VerifiedIdentity = z.infer<typeof VerifiedIdentity>

// ---------- phase 2: market ----------
export const MetalSymbol = z.enum(['XAU', 'XAG', 'XPD'])
export type MetalSymbol = z.infer<typeof MetalSymbol>

export const MarketAsset = z.object({
  symbol: MetalSymbol,
  name: z.string(),
  unit: z.literal('g'),
  /** Feed price per gram, minor units. */
  priceMinor: PositiveMinor,
  /** What the user pays per gram (price plus half the spread). */
  buyPriceMinor: PositiveMinor,
  /** What the user receives per gram (price minus half the spread). */
  sellPriceMinor: PositiveMinor,
  priceAt: IsoTime,
  priceSource: z.string(),
  change24hPct: z.number().optional(),
  history: z.array(z.number().int().nonnegative()),
})
export type MarketAsset = z.infer<typeof MarketAsset>

export const Holding = z.object({ symbol: MetalSymbol, quantityMg: z.number().int().nonnegative(), valueMinor: Minor })
export type Holding = z.infer<typeof Holding>

// ---------- phase 2: proofs ----------
export const StatementLine = z.object({
  activityId: Id,
  date: IsoTime,
  counterparty: z.string(),
  direction: z.enum(['in', 'out']),
  amountMinor: Minor,
  feeMinor: Minor,
  depositTxHash: TxHash.optional(),
  payoutTxHash: TxHash.optional(),
  network: Network,
  /** Present when the amount can be checked against the ledger without trusting Zecca. */
  amountProof: z.string().optional(),
})
export const Statement = z.object({
  id: Id,
  createdAt: IsoTime,
  holder: z.object({ displayName: z.string(), handle: Handle, address: XrplAddress }),
  lines: z.array(StatementLine),
  attestation: z.enum(['zecca', 'proof']),
  signature: z.object({ alg: z.literal('secp256k1'), publicKey: z.string(), value: z.string(), signedPayloadSha256: z.string() }),
})
export type Statement = z.infer<typeof Statement>

// ---------- errors ----------
export const ErrorCode = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'handle_taken',
  'not_signed_up',
  'already_signed_up',
  'limit_reached',
  'insufficient_funds',
  'expired',
  'already_paid',
  'signature_invalid',
  'policy_refused',
  'ledger_error',
  'feature_off',
  'rate_limited',
  'upstream_error',
  'internal',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const LimitName = z.enum(['balance', 'per_payment', 'monthly_send', 'tx_cap', 'daily_cap'])
export type LimitName = z.infer<typeof LimitName>

export const ApiError = z.object({
  error: z.object({
    code: ErrorCode,
    /** English, fit to show to a user as is. */
    message: z.string(),
    /** For limit_reached: which limit, its cap and how much is used. For insufficient_funds: shortMinor. */
    details: z
      .object({
        limit: LimitName.optional(),
        capMinor: Minor.optional(),
        usedMinor: Minor.optional(),
        shortMinor: Minor.optional(),
      })
      .optional(),
  }),
})
export type ApiError = z.infer<typeof ApiError>
