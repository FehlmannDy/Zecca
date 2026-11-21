// Zecca Till connector: pairs a merchant's Android till (apps/merchant-till) without Privy on the phone, then lets that
// till create, read and cancel its own payment requests, and nothing else. Routes (contracts route table, till*):
//   POST /v1/merchant/tills              merchant session -> a single-use 8-character code (10 min) and its QR payload
//   GET  /v1/merchant/tills              merchant session -> the paired tills
//   POST /v1/merchant/tills/:id/revoke   merchant session -> unpairs one (its token stops working at once)
//   POST /v1/till/pair                   public, rate limited: { code, name? } -> { tillToken, merchantName, tillId }
//   POST /v1/till/charges                till token -> PaymentRequest (same creation, expiry and fee as the web till)
//   GET  /v1/till/charges/:id            till token -> PaymentRequest (its own charges only; does not mark them opened)
//   POST /v1/till/charges/:id/cancel     till token -> PaymentRequest
// A till token is not a session: every other route refuses it (lookupSession never finds it).
import type { Context, Hono } from 'hono'
import { formatUsd } from '@zecca/contracts'
import type { Core } from '../../core'
import { Err } from '../../errors'
import { mount } from '../../http'
import { createRateLimiter } from '../../limits'
import { users, type UserRow } from '../../users'
import { requests, toPaymentRequest } from '../../paymentRequests/repo'
import { emitRequest } from '../../paymentRequests/routes'
import { clientAddress } from './address'
import { isCode, normalizeCode } from './schemas'
import { createPairing, ensureTillTables, isTillCharge, listTills, recordCharge, redeemPairing, revokeTill, tillByToken, type TillRow } from './store'

export const TILL_COPY = {
  badCode: 'This code is not valid or has expired. Show a new one in your Zecca merchant space.',
  notPaired: 'This till is not paired. Pair it again from your Zecca merchant space.',
  noCharge: "We couldn't find this charge.",
} as const

/** Pairing attempts per client address per minute, and for everyone together (codes have about 40 bits). */
const PAIR_PER_ADDRESS_PER_MIN = 10
const PAIR_GLOBAL_PER_MIN = 300

function tillOf(core: Core, c: Context): { till: TillRow; merchant: UserRow } {
  const h = c.req.header('authorization')
  const token = h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : undefined
  const till = token ? tillByToken(core, token) : undefined
  const merchant = till && users.byId(core, till.merchantId)
  if (!till || !merchant || merchant.status !== 'active' || !merchant.roles.includes('merchant')) throw Err.unauthorized(TILL_COPY.notPaired)
  return { till, merchant }
}

/** The API origin the till should talk to: API_ORIGIN (set in production), else the origin this request came in on. */
function apiOrigin(core: Core, c: Context): string {
  const env = core.env.API_ORIGIN?.trim().replace(/\/+$/, '')
  if (env) return env
  const u = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || u.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || u.host
  return `${proto}://${host}`
}

export function mountTill(app: Hono, core: Core): void {
  ensureTillTables(core)
  const perAddress = createRateLimiter(core, PAIR_PER_ADDRESS_PER_MIN)
  const everyone = createRateLimiter(core, PAIR_GLOBAL_PER_MIN)

  // ---------- merchant session ----------
  mount(app, core, 'tillPairingCreate', ({ c, user }) => {
    core.rateLimit(`till-code:${user!.id}`)
    const { code, expiresAt } = createPairing(core, user!.id)
    return { pairingCode: code, qrPayload: `zecca-till://pair?api=${encodeURIComponent(apiOrigin(core, c))}&code=${code}`, expiresAt }
  })

  mount(app, core, 'tillList', ({ user }) => ({ items: listTills(core, user!.id) }))

  mount(app, core, 'tillRevoke', ({ user, params }) => {
    if (!revokeTill(core, user!.id, params.id)) throw Err.notFound("We couldn't find this till.")
    return { ok: true as const }
  })

  // ---------- public: the till pairs ----------
  mount(app, core, 'tillPair', ({ c, body }) => {
    perAddress.hit(clientAddress(c))
    everyone.hit('all')
    const code = normalizeCode(body.code)
    const paired = isCode(code) ? redeemPairing(core, code, body.name ?? 'Till') : undefined
    if (!paired) throw Err.badRequest(TILL_COPY.badCode)
    const m = users.byId(core, paired.merchantId)
    core.log.info(`[till] paired ${paired.tillId} to ${paired.merchantId}`)
    return { tillToken: paired.token, merchantName: m?.businessName ?? m?.displayName ?? 'Merchant', tillId: paired.tillId }
  })

  // ---------- till token ----------
  mount(app, core, 'tillChargeCreate', ({ c, body }) => {
    const { till, merchant } = tillOf(core, c)
    const cap = core.settings.txCapMinor
    if (body.amountMinor > cap) throw Err.badRequest(`The most per charge is ${formatUsd(cap)}.`)
    // The same row the merchant's web till creates (paymentRequests/routes.ts, paymentRequestCreate).
    const r = requests.insert(core, {
      id: core.id('pr'),
      merchantId: merchant.id,
      amountMinor: body.amountMinor,
      reference: body.reference?.trim() || undefined,
      status: 'created',
      expiresAt: core.iso(core.now() + core.settings.paymentRequestTtlMs),
    })
    recordCharge(core, r.id, till.id)
    return toPaymentRequest(core, r)
  })

  mount(app, core, 'tillChargeGet', ({ c, params }) => {
    const { till } = tillOf(core, c)
    // The till is the merchant's own screen: reading never marks the request opened (only the customer's page does).
    const r = isTillCharge(core, params.id, till.id) ? requests.refresh(core, params.id) : undefined
    if (!r) throw Err.notFound(TILL_COPY.noCharge)
    return toPaymentRequest(core, r)
  })

  mount(app, core, 'tillChargeCancel', ({ c, params }) => {
    const { till } = tillOf(core, c)
    const r = isTillCharge(core, params.id, till.id) ? requests.refresh(core, params.id) : undefined
    if (!r) throw Err.notFound(TILL_COPY.noCharge)
    // Same rules as POST /v1/payment-requests/:id/cancel.
    if (r.status === 'cancelled') return toPaymentRequest(core, r)
    if (r.status !== 'created' && r.status !== 'opened') throw Err.conflict(r.status === 'paid' ? 'This request has already been paid.' : 'This request has expired.')
    if (r.claimedIntentId) throw Err.conflict('The customer is paying right now.')
    requests.transition(core, r.id, r.status, 'cancelled')
    emitRequest(core, r.id)
    return toPaymentRequest(core, requests.byId(core, r.id)!)
  })
}
