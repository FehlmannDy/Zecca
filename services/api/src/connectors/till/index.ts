// Zecca Till connector: pairs a merchant's Android till (apps/merchant-till) without Privy on the phone, then lets that
// till create, read and cancel its own payment requests, and nothing else.
//   POST /v1/merchant/tills              merchant session -> a single-use 8-character code (10 min) and its QR payload
//   GET  /v1/merchant/tills              merchant session -> the paired tills
//   POST /v1/merchant/tills/:id/revoke   merchant session -> unpairs one (its token stops working at once)
//   POST /v1/till/pair                   public, rate limited: { code, name? } -> { tillToken, merchantName, tillId }
//   POST /v1/till/charges                till token -> PaymentRequest (same creation, expiry and fee as the web till)
//   GET  /v1/till/charges/:id            till token -> PaymentRequest (its own charges only; does not mark them opened)
//   POST /v1/till/charges/:id/cancel     till token -> PaymentRequest
// A till token is not a session: every other route refuses it (lookupSession never finds it).
import type { Context, Hono } from 'hono'
import type { z } from 'zod'
import { PaymentRequestCreate, formatUsd } from '@zecca/contracts'
import type { Core } from '../../core'
import { Err } from '../../errors'
import { zodMessage } from '../../http'
import { lookupSession } from '../../auth/sessions'
import { createRateLimiter } from '../../limits'
import { users, type UserRow } from '../../users'
import { requests, toPaymentRequest } from '../../paymentRequests/repo'
import { emitRequest } from '../../paymentRequests/routes'
import { TillPairRequest, isCode, normalizeCode } from './schemas'
import { createPairing, ensureTillTables, isTillCharge, listTills, recordCharge, redeemPairing, revokeTill, tillByToken, type TillRow } from './store'

export { TillList, TillPairResponse, TillPairingCode, TillView, normalizeCode } from './schemas'

export const TILL_COPY = {
  badCode: 'This code is not valid or has expired. Show a new one in your Zecca merchant space.',
  notPaired: 'This till is not paired. Pair it again from your Zecca merchant space.',
  noCharge: "We couldn't find this charge.",
} as const

/** Pairing attempts per client address per minute, and for everyone together (codes have about 40 bits). */
const PAIR_PER_ADDRESS_PER_MIN = 10
const PAIR_GLOBAL_PER_MIN = 300

function bearer(c: Context): string | undefined {
  const h = c.req.header('authorization')
  return h && /^Bearer\s+/i.test(h) ? h.replace(/^Bearer\s+/i, '').trim() : undefined
}

async function bodyOf<S extends z.ZodType>(c: Context, schema: S, message?: string): Promise<z.output<S>> {
  let raw: unknown
  try {
    raw = await c.req.json()
  } catch {
    throw Err.badRequest('The request body must be JSON.')
  }
  const p = schema.safeParse(raw)
  if (!p.success) throw Err.badRequest(message ?? zodMessage(p.error))
  return p.data
}

function merchantOf(core: Core, c: Context): UserRow {
  const token = bearer(c)
  const s = token ? lookupSession(core, token) : undefined
  if (!s) throw Err.unauthorized()
  if (!s.user || s.user.status !== 'active') throw Err.notSignedUp()
  if (!s.user.roles.includes('merchant')) throw Err.forbidden('This is for business accounts.')
  return s.user
}

function tillOf(core: Core, c: Context): { till: TillRow; merchant: UserRow } {
  const token = bearer(c)
  const till = token ? tillByToken(core, token) : undefined
  const merchant = till && users.byId(core, till.merchantId)
  if (!till || !merchant || merchant.status !== 'active' || !merchant.roles.includes('merchant')) throw Err.unauthorized(TILL_COPY.notPaired)
  return { till, merchant }
}

/** The API origin the till should talk to: API_ORIGIN, else the origin this request came in on. */
function apiOrigin(core: Core, c: Context): string {
  const env = core.env.API_ORIGIN?.trim().replace(/\/+$/, '')
  if (env) return env
  const u = new URL(c.req.url)
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || u.protocol.replace(':', '')
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || u.host
  return `${proto}://${host}`
}

const clientAddress = (c: Context) => c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'local'

export function mountTill(app: Hono, core: Core): void {
  ensureTillTables(core)
  const perAddress = createRateLimiter(core, PAIR_PER_ADDRESS_PER_MIN)
  const everyone = createRateLimiter(core, PAIR_GLOBAL_PER_MIN)

  // ---------- merchant session ----------
  app.post('/v1/merchant/tills', (c) => {
    const m = merchantOf(core, c)
    core.rateLimit(`till-code:${m.id}`)
    const { code, expiresAt } = createPairing(core, m.id)
    const qrPayload = `zecca-till://pair?api=${encodeURIComponent(apiOrigin(core, c))}&code=${code}`
    return c.json({ pairingCode: code, qrPayload, expiresAt })
  })

  app.get('/v1/merchant/tills', (c) => c.json({ items: listTills(core, merchantOf(core, c).id) }))

  app.post('/v1/merchant/tills/:id/revoke', (c) => {
    const m = merchantOf(core, c)
    if (!revokeTill(core, m.id, c.req.param('id'))) throw Err.notFound("We couldn't find this till.")
    return c.json({ ok: true })
  })

  // ---------- public: the till pairs ----------
  app.post('/v1/till/pair', async (c) => {
    perAddress.hit(clientAddress(c))
    everyone.hit('all')
    const body = await bodyOf(c, TillPairRequest, 'Type the 8-character code shown in your Zecca merchant space.')
    const code = normalizeCode(body.code)
    const paired = isCode(code) ? redeemPairing(core, code, body.name ?? 'Till') : undefined
    if (!paired) throw Err.badRequest(TILL_COPY.badCode)
    const m = users.byId(core, paired.merchantId)
    core.log.info(`[till] paired ${paired.tillId} to ${paired.merchantId}`)
    return c.json({ tillToken: paired.token, merchantName: m?.businessName ?? m?.displayName ?? 'Merchant', tillId: paired.tillId })
  })

  // ---------- till token ----------
  app.post('/v1/till/charges', async (c) => {
    const { till, merchant } = tillOf(core, c)
    const body = await bodyOf(c, PaymentRequestCreate)
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
    return c.json(toPaymentRequest(core, r))
  })

  app.get('/v1/till/charges/:id', (c) => {
    const { till } = tillOf(core, c)
    const id = c.req.param('id')
    // The till is the merchant's own screen: reading never marks the request opened (only the customer's page does).
    const r = isTillCharge(core, id, till.id) ? requests.refresh(core, id) : undefined
    if (!r) throw Err.notFound(TILL_COPY.noCharge)
    return c.json(toPaymentRequest(core, r))
  })

  app.post('/v1/till/charges/:id/cancel', (c) => {
    const { till } = tillOf(core, c)
    const id = c.req.param('id')
    const r = isTillCharge(core, id, till.id) ? requests.refresh(core, id) : undefined
    if (!r) throw Err.notFound(TILL_COPY.noCharge)
    // Same rules as POST /v1/payment-requests/:id/cancel.
    if (r.status === 'cancelled') return c.json(toPaymentRequest(core, r))
    if (r.status !== 'created' && r.status !== 'opened') throw Err.conflict(r.status === 'paid' ? 'This request has already been paid.' : 'This request has expired.')
    if (r.claimedIntentId) throw Err.conflict('The customer is paying right now.')
    requests.transition(core, r.id, r.status, 'cancelled')
    emitRequest(core, r.id)
    return c.json(toPaymentRequest(core, requests.byId(core, r.id)!))
  })
}
