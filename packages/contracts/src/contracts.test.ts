import { describe, expect, it } from 'vitest'
import * as C from './index'
import * as F from './fixtures'

describe('fixtures match their schemas', () => {
  const cases: [string, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, unknown][] = [
    ['config', C.PublicConfig, F.config],
    ...Object.entries(F.users).map(([k, v]) => [`user ${k}`, C.User, v] as [string, any, unknown]),
    ...Object.entries(F.profiles).map(([k, v]) => [`profile ${k}`, C.PublicProfile, v] as [string, any, unknown]),
    ['balance', C.Balance, F.balance],
    ['balance arriving', C.Balance, F.balanceArriving],
    ['prepared send', C.PreparedTx, F.preparedSend],
    ['prepared onboarding', C.PreparedTx, F.preparedOnboarding],
    ...Object.entries(F.intents).map(([k, v]) => [`intent ${k}`, C.Intent, v] as [string, any, unknown]),
    ...Object.entries(F.paymentRequests).map(([k, v]) => [`payment request ${k}`, C.PaymentRequest, v] as [string, any, unknown]),
    ...Object.entries(F.activity).map(([k, v]) => [`activity ${k}`, C.Activity, v] as [string, any, unknown]),
    ...Object.entries(F.receipts).map(([k, v]) => [`receipt ${k}`, C.Receipt, v] as [string, any, unknown]),
    ...F.sales.map((s) => [`sale ${s.id}`, C.Sale, s] as [string, any, unknown]),
    ...Object.entries(F.errors).map(([k, v]) => [`error ${k}`, C.ApiError, v] as [string, any, unknown]),
    ...F.events.map((e) => [`event ${e.type}`, C.ZeccaEvent, e] as [string, any, unknown]),
    ['card', C.Card, F.card],
    ['card details', C.CardDetails, F.cardDetails],
    ['card secret', C.CardSecret, F.cardSecret],
    ['earn position', C.EarnPosition, F.earnPosition],
    ['market assets', C.MarketAssetsResponse, F.marketAssets],
    ['holdings', C.HoldingsResponse, F.holdings],
    ['identity session', C.IdentitySession, F.identitySession],
    ['identity verified', C.IdentitySessionStatus, F.identityVerified],
    ['statement', C.Statement, F.statement],
    ['shop items', C.ShopItem.array(), F.shopItems],
    ['ramp session', C.RampSessionResponse, F.rampSession],
  ]
  it.each(cases)('%s', (_name, schema, value) => {
    const r = schema.safeParse(value)
    if (!r.success) throw r.error
    expect(r.success).toBe(true)
  })
})

describe('schemas refuse what they must', () => {
  it('amounts are integers in minor units', () => {
    expect(C.Intent.safeParse({ ...F.intents.p2pCreated, amountMinor: 12.5 }).success).toBe(false)
    expect(C.Intent.safeParse({ ...F.intents.p2pCreated, amountMinor: 0 }).success).toBe(false)
    expect(C.Balance.safeParse({ ...F.balance, availableMinor: -1 }).success).toBe(false)
  })
  it('handles are 3-20 lowercase chars', () => {
    expect(C.Handle.safeParse('ana').success).toBe(true)
    expect(C.Handle.safeParse('An').success).toBe(false)
    expect(C.Handle.safeParse('a'.repeat(21)).success).toBe(false)
    expect(C.Handle.safeParse('ana-b').success).toBe(false)
  })
  it('market order needs exactly one of amount or quantity', () => {
    expect(C.MarketOrderRequest.safeParse({ symbol: 'XAU', side: 'buy', amountMinor: 1000 }).success).toBe(true)
    expect(C.MarketOrderRequest.safeParse({ symbol: 'XAU', side: 'buy' }).success).toBe(false)
    expect(C.MarketOrderRequest.safeParse({ symbol: 'XAU', side: 'buy', amountMinor: 1, quantityMg: 1 }).success).toBe(false)
  })
  it('auth session accepts the privy and the nonce shapes', () => {
    const base = { address: F.ADDR.ana, publicKey: F.PUBKEY.ana }
    expect(C.AuthSessionRequest.safeParse({ ...base, privyToken: 'eyJhbGciOiJFUzI1NiJ9.x.y' }).success).toBe(true)
    expect(C.AuthSessionRequest.safeParse({ ...base, nonce: 'n'.repeat(32), signature: '3045AB' }).success).toBe(true)
    expect(C.AuthSessionRequest.safeParse(base).success).toBe(false)
  })
})

describe('additions requested by the API (C)', () => {
  it("IntentKind includes 'topup' and a submit can answer 'pending'", () => {
    expect(C.IntentKind.safeParse('topup').success).toBe(true)
    expect(C.TxSubmitResponse.safeParse({ status: 'pending', hash: F.HASH.deposit, engineResult: 'terQUEUED' }).success).toBe(true)
  })
})

describe('route table', () => {
  it('every route is under /v1 and unique', () => {
    const keys = Object.values(C.routes).map((r) => `${r.method} ${r.path}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const k of keys) expect(k).toMatch(/^(GET|POST) \/v1\//)
  })
  it('matches concrete paths and fills params', () => {
    expect(C.matchRoute('GET', '/v1/transfers/int_1')).toEqual({ name: 'transferGet', params: { id: 'int_1' } })
    expect(C.matchRoute('GET', '/v1/merchant/sales.csv')?.name).toBe('salesCsv')
    expect(C.matchRoute('GET', '/v1/merchant/sales')?.name).toBe('sales')
    expect(C.matchRoute('POST', '/v1/payment-requests/pr_1/pay')).toEqual({ name: 'paymentRequestPay', params: { id: 'pr_1' } })
    expect(C.matchRoute('DELETE', '/v1/me')).toBeNull()
    expect(C.routePath('paymentRequestGet', { id: 'pr 1' })).toBe('/v1/payment-requests/pr%201')
  })
})

describe('state machines (SPEC §8)', () => {
  it('intent happy path and dead ends', () => {
    expect(C.canTransitionIntent('created', 'submitted')).toBe(true)
    expect(C.canTransitionIntent('submitted', 'received')).toBe(true)
    expect(C.canTransitionIntent('received', 'paid_out')).toBe(true)
    expect(C.canTransitionIntent('created', 'received')).toBe(false)
    expect(C.canTransitionIntent('paid_out', 'failed')).toBe(false)
    expect(C.canTransitionIntent('created', 'expired')).toBe(true)
    expect(C.canTransitionIntent('submitted', 'expired')).toBe(false)
    expect(() => C.assertIntentTransition('failed', 'received')).toThrow(C.InvalidTransition)
  })
  it('payment request', () => {
    expect(C.canTransitionPaymentRequest('created', 'opened')).toBe(true)
    expect(C.canTransitionPaymentRequest('opened', 'paid')).toBe(true)
    expect(C.canTransitionPaymentRequest('paid', 'cancelled')).toBe(false)
    expect(C.canTransitionPaymentRequest('expired', 'paid')).toBe(false)
  })
  it('activity status', () => {
    expect(C.activityStatusOf('submitted')).toBe('pending')
    expect(C.activityStatusOf('received')).toBe('done')
    expect(C.activityStatusOf('expired')).toBe('failed')
  })
})

describe('money', () => {
  it('fee rounds half up in integers', () => {
    expect(C.feeMinor(450, 50)).toBe(2)
    expect(C.feeMinor(100, 50)).toBe(1)
    expect(C.feeMinor(99, 50)).toBe(0)
    expect(C.feeMinor(1200, 0)).toBe(0)
    expect(() => C.feeMinor(1.5, 50)).toThrow()
  })
  it('formats dollars', () => {
    expect(C.formatUsd(1200)).toBe('$12.00')
    expect(C.formatUsd(450)).toBe('$4.50')
    expect(C.formatUsd(123456)).toBe('$1,234.56')
    expect(C.formatUsd(5, { sign: true })).toBe('+$0.05')
    expect(C.formatUsd(-120)).toBe('-$1.20')
    expect(C.splitUsd(834099)).toEqual({ dollars: '8,340', cents: '99' })
  })
  it('parses typed amounts without floats', () => {
    expect(C.parseUsdInput('12')).toBe(1200)
    expect(C.parseUsdInput('12.5')).toBe(1250)
    expect(C.parseUsdInput('$4.50')).toBe(450)
    expect(C.parseUsdInput('1,200.05')).toBe(120005)
    expect(C.parseUsdInput('0.1')).toBe(10)
    expect(C.parseUsdInput('1.234')).toBeNull()
    expect(C.parseUsdInput('abc')).toBeNull()
    expect(C.parseUsdInput('')).toBeNull()
  })
  it('drops and grams', () => {
    expect(C.formatDrops(25_041_000)).toBe('25.041')
    expect(C.formatDrops(1_000_000)).toBe('1')
    expect(C.formatGrams(1500)).toBe('1.5')
    expect(C.spokenUsd(450)).toBe('4 dollars 50')
  })
})
