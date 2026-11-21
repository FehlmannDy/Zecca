import { z } from 'zod'
import {
  Activity,
  Balance,
  Card,
  CardAuthorization,
  CardSecret,
  EarnPosition,
  Holding,
  Intent,
  MarketAsset,
  MetalSymbol,
  PaymentRequest,
  PaymentRequestStatus,
  PreparedTx,
  PublicProfile,
  Receipt,
  Role,
  Sale,
  SalesTotals,
  Statement,
  User,
  VerifiedIdentity,
} from './domain'
import { Handle, Id, IsoTime, Minor, PositiveMinor, PublicKeyHex, TxHash, XrplAddress } from './primitives'

// All routes live under /v1. Requests are JSON bodies unless the name ends in Query.

// ---------- auth ----------
export const AuthNonceRequest = z.object({ address: XrplAddress, publicKey: PublicKeyHex })
export const AuthNonceResponse = z.object({
  nonce: z.string().min(16),
  /** The exact text the client signs (SHA-512Half of its UTF-8 bytes, through the raw_sign contract). */
  message: z.string(),
  expiresAt: IsoTime,
})

export const AuthSessionRequest = z.union([
  z.object({ privyToken: z.string().min(10), address: XrplAddress, publicKey: PublicKeyHex }),
  z.object({ address: XrplAddress, publicKey: PublicKeyHex, nonce: z.string().min(16), signature: z.string().regex(/^[0-9A-Fa-f]+$/) }),
])
export const AuthSessionResponse = z.object({
  token: z.string().min(16),
  /** Absent: not signed up yet. */
  user: User.optional(),
})

// ---------- directory ----------
export const HandleAvailableQuery = z.object({ handle: z.string() })
export const HandleAvailableResponse = z.object({ available: z.boolean(), reason: z.string().optional() })

export const ResolveQuery = z.object({ q: z.string().min(1).max(120) })
export const ResolveResponse = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('zecca'), profile: PublicProfile }),
  z.object({ kind: z.literal('external'), address: XrplAddress }),
  z.object({ kind: z.literal('unknown') }),
])
export const ContactsResponse = z.array(PublicProfile)

// ---------- onboarding ----------
export const OnboardingPrepareRequest = z.object({
  address: XrplAddress,
  publicKey: PublicKeyHex,
  handle: Handle,
  displayName: z.string().min(1).max(60),
  role: Role,
  businessName: z.string().min(1).max(60).optional(),
  email: z.string().email().optional(),
})

// ---------- submit ----------
export const TxSubmitRequest = z.object({ prepareId: Id, txBlob: z.string().regex(/^[0-9A-Fa-f]+$/) })
export const TxSubmitResponse = z.object({
  /** 'pending': sent, but no validated answer yet (network); the intent follows by events and the API settles it from the ledger. */
  status: z.enum(['validated', 'failed', 'pending']),
  hash: TxHash,
  engineResult: z.string(),
  /** The intent this transaction belongs to, after the submit took effect. */
  intent: Intent.optional(),
  /** For onboarding: the user record now active. */
  user: User.optional(),
})

// ---------- transfers / activity ----------
export const TransferRequest = z.object({ to: Id, amountMinor: PositiveMinor, note: z.string().max(140).optional() })
export const IntentWithPrepared = z.object({ intent: Intent, prepared: PreparedTx })
export const ActivityQuery = z.object({ cursor: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() })
export const ActivityPage = z.object({ items: z.array(Activity), nextCursor: z.string().optional() })

// ---------- merchant ----------
export const PaymentRequestCreate = z.object({ amountMinor: PositiveMinor, reference: z.string().max(60).optional() })
export const SalesQuery = z.object({ from: IsoTime.optional(), to: IsoTime.optional() })
export const SalesResponse = z.object({ items: z.array(Sale), totals: SalesTotals })

// ---------- ramp ----------
export const RampSessionRequest = z.object({
  direction: z.enum(['buy', 'sell']),
  fiatAmount: z.number().positive().optional(),
  fiatCurrency: z.string().length(3).optional(),
})
export const RampSessionResponse = z.object({
  /** Fully signed widget URL (can be opened directly). */
  widgetUrl: z.string().url(),
  externalId: Id,
  /** Params for the MoonPay web SDK overlay, if the page uses the SDK. */
  params: z.record(z.string(), z.string()).optional(),
  sandbox: z.boolean(),
})
export const RampSignRequest = z.object({ url: z.string().url() })
export const RampSignResponse = z.object({ signature: z.string() })

export const DevCreditRequest = z.object({ amountMinor: PositiveMinor })

// ---------- phase 2: card ----------
export const CardDetails = Card.extend({ balanceMinor: Minor, authorizations: z.array(CardAuthorization) })
export const CardLoadRequest = z.object({ amountMinor: PositiveMinor })
export const DevCardSimulateRequest = z.object({ amountMinor: PositiveMinor, merchantName: z.string().min(1).max(40) })
export const DevCardSimulateResponse = z.object({ approved: z.boolean(), authorization: CardAuthorization.optional() })

// ---------- phase 2: demo shop ----------
export const ShopItem = z.object({ sku: z.string(), name: z.string(), priceMinor: PositiveMinor, description: z.string().optional() })
export const ShopOrderCreate = z.object({ items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1).max(20) })).min(1) })
export const ShopOrderCreated = z.object({ orderId: Id, amountMinor: PositiveMinor, paymentRequest: PaymentRequest })
export const ShopCharge = z.object({
  orderId: Id,
  pan: z.string().regex(/^\d{12,19}$/),
  expMonth: z.number().int().min(1).max(12),
  expYear: z.number().int(),
  cvc: z.string().regex(/^\d{3,4}$/),
})
export const ShopChargeResponse = z.object({ approved: z.boolean(), receipt: Receipt.optional(), message: z.string().optional() })
export const ShopOrder = z.object({
  id: Id,
  items: z.array(z.object({ sku: z.string(), name: z.string(), qty: z.number().int().positive(), unitMinor: PositiveMinor })),
  amountMinor: PositiveMinor,
  status: z.enum(['pending', 'paid', 'declined']),
  method: z.enum(['zecca', 'card']).optional(),
  paymentRequestId: Id.optional(),
  /** The order's Zecca payment request: its status and expiry (an 'expired' request on a pending order means "Start again"). */
  paymentStatus: PaymentRequestStatus.optional(),
  expiresAt: IsoTime.optional(),
  receipt: Receipt.optional(),
  createdAt: IsoTime,
})

// ---------- phase 2: earn ----------
export const EarnDepositRequest = z.object({ amountMinor: PositiveMinor })
export const EarnDepositResponse = z.object({
  intent: Intent,
  prepared: PreparedTx,
  /** Quote shown before approval. */
  quote: z.object({
    xrpDrops: z.number().int().positive(),
    rateMinorPerXrp: PositiveMinor,
    swapFeeMinor: Minor,
    /** The rate behind the quote, exactly (XRP/USD in micro-dollars), when it was read and from where. */
    microUsdPerXrp: z.number().int().positive().optional(),
    rateAt: IsoTime.optional(),
    rateSource: z.string().optional(),
  }),
})
export const EarnWithdrawRequest = z.object({ amountDrops: z.number().int().positive() })
export const EarnWithdrawResponse = z.object({ status: z.literal('requested'), claimableAt: IsoTime })

// ---------- phase 2: identity ----------
export const IdentitySession = z.object({ id: Id, qrUrl: z.string(), deepLink: z.string(), expiresAt: IsoTime, mode: z.enum(['live', 'mock']) })
export const IdentitySessionStatus = z.object({
  status: z.enum(['pending', 'verified', 'rejected', 'error']),
  identity: VerifiedIdentity.optional(),
  prepared: PreparedTx.optional(),
  message: z.string().optional(),
})

// ---------- phase 2: market ----------
export const MarketAssetsResponse = z.array(MarketAsset)
export const HoldingsResponse = z.array(Holding)
export const MarketOrderRequest = z
  .object({ symbol: MetalSymbol, side: z.enum(['buy', 'sell']), amountMinor: PositiveMinor.optional(), quantityMg: z.number().int().positive().optional() })
  .refine((o) => (o.amountMinor === undefined) !== (o.quantityMg === undefined), { message: 'Give either an amount or a quantity.' })
export const MarketOrderResponse = z.object({
  orderId: Id,
  intent: Intent.optional(),
  prepared: PreparedTx,
  /** Extra approvals needed before this one (e.g. first purchase of a metal). */
  preparedBefore: z.array(PreparedTx).optional(),
  quote: z.object({ quantityMg: z.number().int().positive(), amountMinor: PositiveMinor, unitPriceMinor: PositiveMinor, spreadMinor: Minor }),
})

// ---------- phase 2: proofs ----------
export const DisclosureRequest = z.object({ activityIds: z.array(Id).min(1).max(200) })
export const DisclosureResponse = z.object({ id: Id, url: z.string().url() })
export const DisclosureStatement = Statement

// ---------- misc ----------
export const Ok = z.object({ ok: z.literal(true) })
export const HealthResponse = z.object({ ok: z.boolean(), ledger: z.enum(['mock', 'devnet']), version: z.string() })
