// Realistic example objects for every schema. The web's mock API (MSW) serves these; tests validate them against the schemas.
import type { z } from 'zod'
import type * as A from './api'
import type { PublicConfig } from './config'
import type {
  Activity,
  Balance,
  Card,
  CardAuthorization,
  CardSecret,
  EarnPosition,
  Holding,
  Intent,
  MarketAsset,
  PaymentRequest,
  PreparedTx,
  PublicProfile,
  Receipt,
  Sale,
  Statement,
  User,
} from './domain'
import type { ZeccaEvent } from './events'

const T0 = '2026-11-21T09:30:00.000Z'
const at = (min: number) => new Date(Date.parse(T0) + min * 60_000).toISOString()

export const ADDR = {
  sponsor: 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT',
  issuer: 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3',
  pool: 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ',
  cardSettlement: 'rfPnRVpntUGgeaX64Z7DNy2XHkqL5qHZ8L',
  ana: 'r9PTtbEVNxpEhXEnKg7N8nddMzmJccmhbd',
  bruno: 'rsvhMtAFLX2HvJgXEvZGeqTviucdndHuFN',
  carla: 'r34PYpD846aYCuym5oJzRmNsGUbyjV2UYD',
  shop: 'rw7gnmRvbznR6qQSra4eLX5hu8APx5PaKs',
} as const
export const CMPT = '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9'
export const HASH = {
  onboarding: 'C8594C53E2A1D0F7B6C5A4938271605F4E3D2C1B0A99887766554433221100AB55'.slice(0, 64),
  deposit: 'D1DAE5A94F0E1D2C3B4A59687766554433221100FFEEDDCCBBAA998877663777',
  payout: '7A1F3C5E9B2D4F6A8C0E1B3D5F7A9C2E4B6D8F0A1C3E5B7D9F2A4C6E8B0D1F3A',
  coffeeDeposit: '0B5E8C2F4A7D9E1B3C6F8A0D2E5B7C9F1A4D6E8B0C3F5A7D9E2B4C6F8A1D3E5B',
  coffeePayout: 'A4C6E8B0D2F4A6C8E0B2D4F6A8C0E2B4D6F8A0C2E4B6D8F0A2C4E6B8D0F2A4C6',
  topup: '548D695E91F1F48720D64F0380C084DE3E0A6A4F97CA1599B79324FB5A1F8939',
} as const
export const PUBKEY = {
  ana: '03A4B8C2D6E0F4A8B2C6D0E4F8A2B6C0D4E8F2A6B0C4D8E2F6A0B4C8D2E6F0A4B8',
  bruno: '02B5C9D3E7F1A5B9C3D7E1F5A9B3C7D1E5F9A3B7C1D5E9F3A7B1C5D9E3F7A1B5C9',
  carla: '03C6D0E4F8A2B6C0D4E8F2A6B0C4D8E2F6A0B4C8D2E6F0A4B8C2D6E0F4A8B2C6D0',
}

export const config: z.input<typeof PublicConfig> = {
  network: 'devnet',
  ledgerMode: 'mock',
  signerMode: 'mock',
  demoMode: true,
  addresses: { sponsor: ADDR.sponsor, issuer: ADDR.issuer, pool: ADDR.pool },
  issuanceId: CMPT,
  features: {
    ramp: true,
    withdraw: false,
    card: false,
    earn: false,
    market: false,
    identity: false,
    proofs: false,
    demoShop: true,
    passkey: false,
    googleLogin: false,
  },
  limits: { txCapMinor: 500_000, dailyCapMinor: 1_000_000, tier0: { balanceCapMinor: 15_000, txCapMinor: 5_000, monthlySendCapMinor: 15_000 } },
  fees: { merchantFeeBps: 50, marketSpreadBps: 100, earnFeeBps: 1000, earnSwapBps: 30 },
  welcomeCreditMinor: 5000,
  rampSandboxScale: 100,
  privyAppId: 'cmwp3ayt902ll0il2cu05wx46',
  explorer: { devnet: 'https://devnet.xrpl.org/transactions/', testnet: 'https://testnet.xrpl.org/transactions/' },
  webOrigin: 'http://localhost:3100',
}

export const users = {
  ana: {
    id: 'usr_ana',
    role: ['user'],
    handle: 'ana',
    displayName: 'Ana Ferri',
    address: ADDR.ana,
    email: 'ana@example.com',
    tier: 0,
    createdAt: at(-60),
  },
  bruno: {
    id: 'usr_bruno',
    role: ['user', 'merchant'],
    handle: 'caffebruno',
    displayName: 'Bruno Esposito',
    address: ADDR.bruno,
    email: 'bruno@example.com',
    tier: 0,
    createdAt: at(-55),
    merchant: { businessName: 'Caffè Bruno', feeBps: 50 },
  },
  carla: {
    id: 'usr_carla',
    role: ['user'],
    handle: 'carla',
    displayName: 'Carla Rossi',
    address: ADDR.carla,
    tier: 1,
    createdAt: at(-50),
  },
} satisfies Record<string, User>

export const profiles = {
  ana: { id: users.ana.id, handle: 'ana', displayName: 'Ana Ferri', isMerchant: false },
  bruno: { id: users.bruno.id, handle: 'caffebruno', displayName: 'Caffè Bruno', isMerchant: true },
  carla: { id: users.carla.id, handle: 'carla', displayName: 'Carla Rossi', isMerchant: false },
} satisfies Record<string, PublicProfile>

export const balance: Balance = { availableMinor: 8340, pendingMinor: 0, updatedAt: at(12) }
export const balanceArriving: Balance = { availableMinor: 8340, pendingMinor: 1200, updatedAt: at(12) }

export const preparedSend: PreparedTx = {
  prepareId: 'prep_01JDX4C3',
  kind: 'send',
  expiresAt: at(8),
  tx: {
    TransactionType: 'ConfidentialMPTSend',
    Account: ADDR.ana,
    Destination: ADDR.pool,
    MPTokenIssuanceID: CMPT,
    Sponsor: ADDR.sponsor,
    SponsorFlags: 1,
    Fee: '12',
    Sequence: 5_402_118,
    LastLedgerSequence: 5_402_390,
    SigningPubKey: PUBKEY.ana,
    SenderEncryptedAmount: '02B1C3' + 'A0'.repeat(63),
    DestinationEncryptedAmount: '03D4E5' + 'B1'.repeat(63),
    IssuerEncryptedAmount: '02F6A7' + 'C2'.repeat(63),
    ZKProof: 'E3'.repeat(96),
  },
}

export const preparedOnboarding: PreparedTx = {
  prepareId: 'prep_01JDX3ON',
  kind: 'onboarding',
  expiresAt: at(-50),
  tx: {
    TransactionType: 'Batch',
    Account: ADDR.ana,
    Flags: 0x10000,
    Sponsor: ADDR.sponsor,
    SponsorFlags: 1,
    Fee: '60',
    Sequence: 5_401_000,
    LastLedgerSequence: 5_401_150,
    SigningPubKey: PUBKEY.ana,
    RawTransactions: [],
    BatchSigners: [],
  },
}

export const intents = {
  p2pCreated: {
    id: 'int_p2p_carla',
    kind: 'p2p',
    status: 'created',
    fromUserId: users.ana.id,
    toUserId: users.carla.id,
    amountMinor: 1200,
    feeMinor: 0,
    note: 'Dinner',
    createdAt: at(1),
    updatedAt: at(1),
  },
  p2pPaid: {
    id: 'int_p2p_carla',
    kind: 'p2p',
    status: 'paid_out',
    fromUserId: users.ana.id,
    toUserId: users.carla.id,
    amountMinor: 1200,
    feeMinor: 0,
    note: 'Dinner',
    depositTxHash: HASH.deposit,
    payoutTxHash: HASH.payout,
    createdAt: at(1),
    updatedAt: at(2),
  },
  coffeeReceived: {
    id: 'int_coffee',
    kind: 'merchant',
    status: 'received',
    fromUserId: users.ana.id,
    toUserId: users.bruno.id,
    amountMinor: 450,
    feeMinor: 2,
    paymentRequestId: 'pr_coffee',
    depositTxHash: HASH.coffeeDeposit,
    createdAt: at(5),
    updatedAt: at(5),
  },
} satisfies Record<string, Intent>

export const paymentRequests = {
  created: {
    id: 'pr_coffee',
    merchantId: users.bruno.id,
    merchantName: 'Caffè Bruno',
    amountMinor: 450,
    reference: 'Table 4',
    status: 'created',
    url: 'http://localhost:3100/pay/pr_coffee',
    expiresAt: at(15),
  },
  paid: {
    id: 'pr_coffee',
    merchantId: users.bruno.id,
    merchantName: 'Caffè Bruno',
    amountMinor: 450,
    reference: 'Table 4',
    status: 'paid',
    url: 'http://localhost:3100/pay/pr_coffee',
    expiresAt: at(15),
    paidAt: at(5),
    intentId: 'int_coffee',
  },
  expired: {
    id: 'pr_old',
    merchantId: users.bruno.id,
    merchantName: 'Caffè Bruno',
    amountMinor: 300,
    status: 'expired',
    url: 'http://localhost:3100/pay/pr_old',
    expiresAt: at(-20),
  },
} satisfies Record<string, PaymentRequest>

export const receipts = {
  shopZecca: {
    orderNumber: 'SA-1042',
    shopName: 'Sette Archi',
    items: [{ name: 'Etiopia Guji, 250 g', qty: 1, unitMinor: 1450 }],
    amountMinor: 1450,
    method: 'zecca',
    status: 'completed',
    at: at(9),
    reference: 'pr_shop_1042',
  },
  shopCard: {
    orderNumber: 'SA-1043',
    shopName: 'Sette Archi',
    items: [{ name: 'Moka pot, 3 cups', qty: 1, unitMinor: 3200 }],
    amountMinor: 3200,
    method: 'card',
    cardLast4: '4417',
    status: 'authorised',
    at: at(11),
    reference: 'txn_8f2c1d',
  },
} satisfies Record<string, Receipt>

export const activity = {
  welcome: {
    id: 'act_welcome',
    intentId: 'int_welcome',
    direction: 'in',
    kind: 'welcome',
    amountMinor: 5000,
    feeMinor: 0,
    status: 'done',
    note: 'Demo credit',
    at: at(-50),
    ledger: { depositTxHash: HASH.onboarding, network: 'devnet' },
  },
  topup: {
    id: 'act_topup',
    intentId: 'int_topup',
    direction: 'in',
    kind: 'topup',
    amountMinor: 4000,
    feeMinor: 0,
    status: 'done',
    at: at(0),
    ledger: { depositTxHash: HASH.topup, network: 'testnet' },
  },
  sentCarla: {
    id: 'act_p2p_carla_out',
    intentId: 'int_p2p_carla',
    direction: 'out',
    kind: 'p2p',
    counterparty: profiles.carla,
    amountMinor: 1200,
    feeMinor: 0,
    status: 'done',
    note: 'Dinner',
    at: at(1),
    ledger: { depositTxHash: HASH.deposit, payoutTxHash: HASH.payout, network: 'devnet', ciphertextPreview: '03D4E5B1B1B1B1B1' },
  },
  coffee: {
    id: 'act_coffee_out',
    intentId: 'int_coffee',
    direction: 'out',
    kind: 'merchant',
    counterparty: profiles.bruno,
    amountMinor: 450,
    feeMinor: 0,
    status: 'pending',
    note: 'Table 4',
    at: at(5),
    ledger: { depositTxHash: HASH.coffeeDeposit, network: 'devnet', ciphertextPreview: '02A9C4D7E1F3A5B7' },
  },
  shop: {
    id: 'act_shop_out',
    intentId: 'int_shop_1042',
    direction: 'out',
    kind: 'merchant',
    counterparty: { id: 'usr_shop', handle: 'settearchi', displayName: 'Sette Archi', isMerchant: true },
    amountMinor: 1450,
    feeMinor: 0,
    status: 'done',
    at: at(9),
    ledger: { depositTxHash: HASH.coffeeDeposit, payoutTxHash: HASH.coffeePayout, network: 'devnet', ciphertextPreview: '03B2E6F0A4C8D2E6' },
    receipt: receipts.shopZecca,
  },
} satisfies Record<string, Activity>

export const sales: Sale[] = [
  { id: 'sale_1', paymentRequestId: 'pr_coffee', amountMinor: 450, feeMinor: 2, netMinor: 448, payer: profiles.ana, reference: 'Table 4', paidAt: at(5), payoutStatus: 'pending' },
  { id: 'sale_2', paymentRequestId: 'pr_cornetto', amountMinor: 180, feeMinor: 1, netMinor: 179, paidAt: at(-30), payoutStatus: 'done' },
]

export const errors = {
  limit: {
    error: {
      code: 'limit_reached',
      message: "You've reached the limit for unverified accounts. Verify your identity to lift it.",
      details: { limit: 'per_payment', capMinor: 5000, usedMinor: 6000 },
    },
  },
  insufficient: { error: { code: 'insufficient_funds', message: 'You need $1.20 more.', details: { shortMinor: 120 } } },
  expired: { error: { code: 'expired', message: 'This request has expired. Ask the merchant for a new one.' } },
  alreadyPaid: { error: { code: 'already_paid', message: 'This request has already been paid.' } },
  handleTaken: { error: { code: 'handle_taken', message: 'Taken, try another.' } },
} satisfies Record<string, z.input<typeof import('./domain').ApiError>>

export const events: ZeccaEvent[] = [
  { type: 'balance.updated', data: balance, at: at(12) },
  { type: 'intent.updated', data: intents.coffeeReceived, at: at(5) },
  { type: 'payment_request.updated', data: paymentRequests.paid, at: at(5) },
  { type: 'activity.created', data: activity.coffee, at: at(5) },
  { type: 'card.authorization', data: { id: 'auth_1', amountMinor: 3200, merchant: 'Sette Archi', approved: true, status: 'authorised', at: at(11) }, at: at(11) },
]

// ---------- phase 2 ----------
export const card: Card = { id: 'card_01', last4: '4417', expMonth: 11, expYear: 2029, state: 'OPEN', holderName: 'Ana Ferri' }
export const cardAuthorizations: CardAuthorization[] = [
  { id: 'auth_1', amountMinor: 3200, merchant: 'Sette Archi', approved: true, status: 'completed', at: at(11) },
  { id: 'auth_2', amountMinor: 9900, merchant: 'Sette Archi', approved: false, status: 'declined', declineReason: 'Declined, not enough on the card', at: at(12) },
]
export const cardDetails: z.input<typeof A.CardDetails> = { ...card, balanceMinor: 1800, authorizations: cardAuthorizations }
export const cardSecret: CardSecret = { pan: '4111111111114417', cvc: '123', expMonth: 11, expYear: 2029 }

export const earnPosition: EarnPosition = {
  depositedDrops: 25_000_000,
  valueDrops: 25_041_000,
  valueUsdMinor: 5010,
  history: [
    { at: at(-240), valueDrops: 25_000_000 },
    { at: at(-120), valueDrops: 25_018_000 },
    { at: at(0), valueDrops: 25_041_000 },
  ],
  status: 'active',
}

export const marketAssets: MarketAsset[] = [
  { symbol: 'XAU', name: 'Gold', unit: 'g', priceMinor: 8412, buyPriceMinor: 8454, sellPriceMinor: 8370, priceAt: at(0), priceSource: 'Fixture 2026-11-20', change24hPct: 0.4, history: [8350, 8371, 8390, 8384, 8402, 8412] },
  { symbol: 'XAG', name: 'Silver', unit: 'g', priceMinor: 102, buyPriceMinor: 103, sellPriceMinor: 101, priceAt: at(0), priceSource: 'Fixture 2026-11-20', change24hPct: -0.8, history: [104, 104, 103, 103, 102, 102] },
  { symbol: 'XPD', name: 'Palladium', unit: 'g', priceMinor: 3320, buyPriceMinor: 3337, sellPriceMinor: 3303, priceAt: at(0), priceSource: 'Fixture 2026-11-20', change24hPct: 1.1, history: [3270, 3281, 3295, 3302, 3311, 3320] },
]
export const holdings: Holding[] = [{ symbol: 'XAU', quantityMg: 1500, valueMinor: 12618 }]

export const identitySession: z.input<typeof A.IdentitySession> = {
  id: 'idv_01',
  qrUrl: 'eudi-openid4vp://?client_id=x509_san_dns%3Averifier-backend.eudiw.dev&request_uri=https%3A%2F%2Fverifier-backend.eudiw.dev%2Fwallet%2Frequest.jwt%2Fabc',
  deepLink: 'eudi-openid4vp://?client_id=x509_san_dns%3Averifier-backend.eudiw.dev&request_uri=https%3A%2F%2Fverifier-backend.eudiw.dev%2Fwallet%2Frequest.jwt%2Fabc',
  expiresAt: at(10),
  mode: 'mock',
}
export const identityVerified: z.input<typeof A.IdentitySessionStatus> = {
  status: 'verified',
  identity: { givenName: 'Ana', familyName: 'Ferri', birthDate: '1994-03-12', over18: true },
}

export const statement: Statement = {
  id: 'stm_01',
  createdAt: at(30),
  holder: { displayName: 'Ana Ferri', handle: 'ana', address: ADDR.ana },
  lines: [
    { activityId: 'act_p2p_carla_out', date: at(1), counterparty: 'Carla Rossi', direction: 'out', amountMinor: 1200, feeMinor: 0, depositTxHash: HASH.deposit, payoutTxHash: HASH.payout, network: 'devnet' },
  ],
  attestation: 'zecca',
  signature: { alg: 'secp256k1', publicKey: PUBKEY.bruno, value: '3045022100AB', signedPayloadSha256: 'ab'.repeat(32) },
}

export const shopItems: z.input<typeof A.ShopItem>[] = [
  { sku: 'guji-250', name: 'Etiopia Guji, 250 g', priceMinor: 1450, description: 'Bergamot, peach, black tea. Light roast.' },
  { sku: 'huila-250', name: 'Colombia Huila, 250 g', priceMinor: 1250, description: 'Red apple, caramel. Medium roast.' },
  { sku: 'moka-3', name: 'Moka pot, 3 cups', priceMinor: 3200 },
  { sku: 'grinder', name: 'Hand grinder', priceMinor: 9900, description: 'Steel burrs. Built to last.' },
]

export const rampSession: z.input<typeof A.RampSessionResponse> = {
  widgetUrl: 'https://buy-sandbox.moonpay.com/?apiKey=pk_test_x&currencyCode=rlusd_xrp&signature=abc',
  externalId: 'rmp_01JDX5',
  sandbox: true,
}
