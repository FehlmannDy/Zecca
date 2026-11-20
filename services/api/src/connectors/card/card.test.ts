// The card connector end to end on the API (SPEC §4.6, §4.14, §6.3): card, load through the pool, the ASA webhook
// answered from the card balance, settlement after the answer, test purchases, the demo shop's "Pay by card",
// voids, clearing and returns. Lithic is the in-memory fake; it calls our webhook like the sandbox does.
import xrpl from 'xrpl'
import { describe, expect, it } from 'vitest'
import { CardDetails, ShopChargeResponse, type ZeccaEvent } from '@zecca/contracts'
import { makeHarness, type TestUser } from '../../testing/harness'
import { users } from '../../users'
import { createFakeLithic, type FakeLithic } from './fake-lithic'
import { sampleAuthorization, signHeaders } from './lithic-sig'
import { cardChargeForOrder, cardBalanceOf, cardSync, mountCard, registerCard, type CardOptions } from './index'

type H = ReturnType<typeof makeHarness>

async function world(o: { env?: Record<string, string>; tier?: 0 | 1; card?: CardOptions } = {}) {
  const h = makeHarness({ env: { FEATURE_CARD: '1', ...o.env } })
  const w = xrpl.Wallet.generate('ecdsa-secp256k1' as never)
  h.keystore.setWallet('cardSettlement', { address: w.classicAddress, seed: w.seed!, algorithm: 'ecdsa-secp256k1' })
  const lithic = createFakeLithic()
  mountCard(h.app, h.app.core, { lithic, simulateGapMs: 0, pollMs: 0, ...o.card })
  registerCard(h.app.core)
  lithic.asa = async (body) => {
    const r = await asa(h, lithic, body)
    if (r.status !== 200) throw new Error(`asa ${r.status}`)
    return r.body.result
  }
  const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
  if ((o.tier ?? 1) === 1) users.setTier(h.app.core, ana.user.id, 1)
  return { h, lithic, ana, settlement: w.classicAddress }
}

/** What Lithic sends: the raw JSON and its signed headers (timestamps on the API's clock). */
async function asa(h: H, lithic: FakeLithic, body: object, o: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body)
  const headers = signHeaders(raw, o.secret ?? lithic.secret, { ts: o.ts ?? Math.floor(h.clock.now / 1000) })
  const res = await h.call('POST', '/v1/webhooks/lithic/asa', { body: raw, headers: { 'content-type': 'application/json', ...headers } })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : undefined }
}

const events = (h: H, userId: string, type: ZeccaEvent['type']) =>
  h.app.core.bus
    .history()
    .filter((x) => x.to === `user:${userId}` && x.event.type === type)
    .map((x) => x.event.data as any)

async function cardWith(h: H, ana: TestUser, loadMinor: number) {
  const c = await h.json('POST', '/v1/card', { token: ana.token })
  expect(c.status).toBe(200)
  if (loadMinor > 0) {
    const l = await h.json('POST', '/v1/card/load', { token: ana.token, body: { amountMinor: loadMinor } })
    expect(l.status).toBe(200)
    expect((await h.submit(ana, l.body.prepared)).body.status).toBe('validated')
    await h.settle()
  }
  return c.body
}

const secretOf = async (h: H, ana: TestUser) => (await h.json('GET', '/v1/card/secret', { token: ana.token })).body
const order = async (h: H, items = [{ sku: 'guji-250', qty: 1 }]) => (await h.json('POST', '/v1/demo/shop/orders', { body: { items } })).body
type Secret = { pan: string; expMonth: number; expYear: number; cvc: string }
const payByCard = (h: H, orderId: string, s: Secret) =>
  h.json('POST', '/v1/demo/shop/charge', { body: { orderId, pan: s.pan, expMonth: s.expMonth, expYear: s.expYear, cvc: s.cvc } })
const holdRow = (h: H, token: string) =>
  h.app.core.db.prepare('SELECT status, amount_minor AS amountMinor, settle_tx AS settleTx, settle_error AS settleError FROM card_holds WHERE auth_token = ?').get(token) as
    | { status: string; amountMinor: number; settleTx: string | null; settleError: string | null }
    | undefined
/** Our webhook answers, but the answer reaches Lithic too late: the fake records ISSUER_TIMEOUT, i.e. DECLINED. */
const lateAnswers = (lithic: FakeLithic) => {
  const answer = lithic.asa!
  lithic.asa = async (b) => {
    await answer(b)
    throw new Error('the answer reached Lithic too late')
  }
}
const DECLINED_COPY = 'Card declined. Try another payment method.'

describe('card routes behind the flag', () => {
  it('are off (404 feature_off) without FEATURE_CARD, webhook included', async () => {
    const h = makeHarness()
    mountCard(h.app, h.app.core, { lithic: createFakeLithic(), pollMs: 0 })
    registerCard(h.app.core)
    const ana = await h.signUp('ana')
    for (const [m, p] of [
      ['GET', '/v1/card'],
      ['POST', '/v1/card'],
      ['GET', '/v1/card/secret'],
      ['POST', '/v1/card/freeze'],
    ] as const) {
      const r = await h.json(m, p, { token: ana.token })
      expect([r.status, r.body.error.code]).toEqual([404, 'feature_off'])
    }
    const w = await h.json('POST', '/v1/webhooks/lithic/asa', { body: {} })
    expect([w.status, w.body.error.code]).toEqual([404, 'feature_off'])
  })
})

describe('the card', () => {
  it('needs a verified identity (tier 1)', async () => {
    const { h, ana } = await world({ tier: 0 })
    const r = await h.json('POST', '/v1/card', { token: ana.token })
    expect([r.status, r.body.error.code]).toEqual([403, 'forbidden'])
    expect(r.body.error.message).toMatch(/Verify your identity/)
    expect((await h.json('GET', '/v1/card', { token: ana.token })).status).toBe(404)
  })

  it('creates one virtual sandbox card per person, with the holder name', async () => {
    const { h, lithic, ana } = await world()
    const [a, b] = await Promise.all([h.json('POST', '/v1/card', { token: ana.token }), h.json('POST', '/v1/card', { token: ana.token })])
    expect(a.status).toBe(200)
    expect(a.body).toMatchObject({ state: 'OPEN', holderName: 'Ana Ferri', expMonth: 11, expYear: 2029 })
    expect(a.body.last4).toMatch(/^\d{4}$/)
    expect(b.body).toEqual(a.body)
    expect(lithic.calls.filter((c) => c === 'createCard')).toHaveLength(1)
    const again = await h.json('POST', '/v1/card', { token: ana.token })
    expect(again.body.id).toBe(a.body.id)
  })

  it('GET /v1/card: the card, its balance and its payments', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 0)
    const r = await h.json('GET', '/v1/card', { token: ana.token })
    expect(r.status).toBe(200)
    expect(CardDetails.safeParse(r.body).success).toBe(true)
    expect(r.body).toMatchObject({ balanceMinor: 0, authorizations: [] })
  })

  it('GET /v1/card/secret reads number, code and expiry from Lithic and never stores them', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 0)
    const res = await h.call('GET', '/v1/card/secret', { token: ana.token })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const s = await res.json()
    const lc = [...lithic.cards.values()][0]
    expect(s).toEqual({ pan: lc.pan, cvc: lc.cvv, expMonth: 11, expYear: 2029 })
    const dump = JSON.stringify(h.app.core.db.prepare('SELECT * FROM card_cards').all())
    expect(dump).not.toContain(lc.pan)
  })

  it('freezes and unfreezes on Lithic (PAUSED / OPEN)', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 0)
    const f = await h.json('POST', '/v1/card/freeze', { token: ana.token })
    expect(f.body.state).toBe('PAUSED')
    expect([...lithic.cards.values()][0].state).toBe('PAUSED')
    expect((await h.json('GET', '/v1/card', { token: ana.token })).body.state).toBe('PAUSED')
    const u = await h.json('POST', '/v1/card/unfreeze', { token: ana.token })
    expect(u.body.state).toBe('OPEN')
  })

  it('says so in plain words when Lithic does not answer', async () => {
    const { h, lithic, ana } = await world()
    lithic.failNext('createCard', 503)
    const r = await h.json('POST', '/v1/card', { token: ana.token })
    expect([r.status, r.body.error.code]).toEqual([502, 'upstream_error'])
    expect(r.body.error.message).not.toMatch(/lithic|http/i)
  })
})

describe('loading the card (intent card_load through the pool)', () => {
  it('one approval: the deposit to the pool is credited to the card balance on received, once', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 0)
    const l = await h.json('POST', '/v1/card/load', { token: ana.token, body: { amountMinor: 2000 } })
    expect(l.status).toBe(200)
    expect(l.body.intent).toMatchObject({ kind: 'card_load', status: 'created', amountMinor: 2000, fromUserId: ana.user.id })
    expect(l.body.intent.toUserId).toBeUndefined()
    expect(l.body.prepared).toMatchObject({ kind: 'send' })
    expect(l.body.prepared.tx.Destination).toBe(h.keystore.getWallet('pool').address)
    expect((await h.submit(ana, l.body.prepared)).body.status).toBe('validated')
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(3000)
    await h.settle()
    expect((await h.json('GET', '/v1/card', { token: ana.token })).body.balanceMinor).toBe(2000)
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2000)
    expect((await h.json('GET', `/v1/transfers/${l.body.intent.id}`, { token: ana.token })).body.status).toBe('received')
    expect(h.pool.payouts).toHaveLength(0) // the money stays in the pool: it backs the card
    // The app hears it: a balance with the card part.
    expect(events(h, ana.user.id, 'balance.updated').at(-1)).toMatchObject({ availableMinor: 3000, cardMinor: 2000 })
    // A second 'received' for the same intent changes nothing.
    await h.app.core.receivedHandlers.get('card_load')!(h.app.core, l.body.intent.id)
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2000)
    const act = await h.json('GET', '/v1/activity', { token: ana.token })
    expect(act.body.items[0]).toMatchObject({ kind: 'card_load', direction: 'out', amountMinor: 2000, status: 'done' })
  })

  it('refuses more than the balance, a load without a card, and an unverified account', async () => {
    const { h, ana } = await world()
    expect((await h.json('POST', '/v1/card/load', { token: ana.token, body: { amountMinor: 100 } })).status).toBe(404)
    await cardWith(h, ana, 0)
    const r = await h.json('POST', '/v1/card/load', { token: ana.token, body: { amountMinor: 6000 } })
    expect([r.status, r.body.error.code]).toEqual([409, 'insufficient_funds'])
    users.setTier(h.app.core, ana.user.id, 0)
    expect((await h.json('POST', '/v1/card/load', { token: ana.token, body: { amountMinor: 100 } })).status).toBe(403)
  })
})

describe('POST /v1/webhooks/lithic/asa', () => {
  const tokenOf = async (h: H) => (h.app.core.db.prepare('SELECT lithic_token AS t FROM card_cards').get() as { t: string }).t

  it('refuses a bad signature or an old timestamp, and spends nothing', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 1000)
    const body = sampleAuthorization({ token: 't0', cardToken: await tokenOf(h), amount: 100 })
    expect((await asa(h, lithic, body, { secret: 'whsec_' + Buffer.from('wrong').toString('base64') })).status).toBe(401)
    expect((await asa(h, lithic, body, { ts: Math.floor(h.clock.now / 1000) - 301 })).status).toBe(401)
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(1000)
  })

  it('answers from the card balance without touching the ledger', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 1000)
    const submittedBefore = h.ledger.submitted.length
    const r = await asa(h, lithic, sampleAuthorization({ token: 't1', cardToken: await tokenOf(h), amount: 600, descriptor: 'SETTE ARCHI' }))
    expect(r).toEqual({ status: 200, body: { token: 't1', result: 'APPROVED' } })
    expect(h.ledger.submitted.length).toBe(submittedBefore)
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(400)
    expect(events(h, ana.user.id, 'card.authorization').at(-1)).toMatchObject({ id: 't1', amountMinor: 600, merchant: 'Sette Archi', approved: true, status: 'authorised' })
  })

  it('settles pool -> card settlement account once the purchase clears, for the cleared amount, once', async () => {
    const { h, lithic, ana, settlement } = await world()
    await cardWith(h, ana, 1000)
    const pan = (await secretOf(h, ana)).pan
    const { token } = await lithic.simulateAuthorize({ amount: 600, descriptor: 'SETTE ARCHI', pan })
    await h.settle()
    // Not at the answer: a void or a late decline before the clearing has nothing to undo on the ledger.
    expect(h.pool.payouts).toEqual([])
    // The shop takes less than it authorised: the difference goes back to the card, only what was taken settles.
    await lithic.simulateClearing({ token, amount: 450 })
    await cardSync(h.app.core)
    await h.settle()
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(550)
    expect(h.pool.payouts).toEqual([{ intentId: `cset_${token}`, to: settlement, amountMinor: 450 }])
    expect(holdRow(h, token)).toMatchObject({ status: 'completed', amountMinor: 450 })
    expect(holdRow(h, token)!.settleTx).toMatch(/^[0-9A-F]{64}$/)
    await cardSync(h.app.core)
    await h.settle()
    expect(h.pool.payouts).toHaveLength(1)
  })

  it('declines above the balance with INSUFFICIENT_FUNDS and says why to the cardholder', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 1000)
    const r = await asa(h, lithic, sampleAuthorization({ token: 't2', cardToken: await tokenOf(h), amount: 1001 }))
    expect(r.body).toEqual({ token: 't2', result: 'INSUFFICIENT_FUNDS' })
    expect(events(h, ana.user.id, 'card.authorization').at(-1)).toMatchObject({ approved: false, status: 'declined', declineReason: 'Declined, not enough on the card' })
    await h.settle()
    expect(h.pool.payouts).toHaveLength(0)
  })

  it('a retry of the same authorization gets the same answer and spends once', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 1000)
    const body = sampleAuthorization({ token: 't3', cardToken: await tokenOf(h), amount: 700 })
    expect((await asa(h, lithic, body)).body.result).toBe('APPROVED')
    expect((await asa(h, lithic, body)).body.result).toBe('APPROVED')
    await h.settle()
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(300)
    expect(events(h, ana.user.id, 'card.authorization').filter((a) => a.id === 't3')).toHaveLength(1)
  })

  it('declines an unknown card and a frozen card', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 1000)
    expect((await asa(h, lithic, sampleAuthorization({ token: 't4', cardToken: 'nope', amount: 1 }))).body.result).toBe('INSUFFICIENT_FUNDS')
    await h.json('POST', '/v1/card/freeze', { token: ana.token })
    expect((await asa(h, lithic, sampleAuthorization({ token: 't5', cardToken: await tokenOf(h), amount: 1 }))).body.result).toBe('INSUFFICIENT_FUNDS')
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(1000)
  })

  it('approves a credit without spending anything', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 1000)
    const r = await asa(h, lithic, sampleAuthorization({ token: 't6', cardToken: await tokenOf(h), amount: 300, status: 'CREDIT_AUTHORIZATION' }))
    expect(r.body.result).toBe('APPROVED')
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(1000)
  })

  it('a failed settlement is written on the hold; the purchase stands and nothing retries', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 1000)
    h.pool.failPayouts = true
    const r = await h.json('POST', '/v1/dev/card/simulate', { token: ana.token, body: { amountMinor: 100, merchantName: 'Sette Archi' } })
    expect(r.body.approved).toBe(true)
    await h.settle()
    await cardSync(h.app.core)
    await h.settle()
    const row = holdRow(h, r.body.authorization.id)!
    expect(row.status).toBe('completed')
    expect(row.settleError).toMatch(/payout refused/)
    expect(h.pool.payouts).toHaveLength(1)
  })

  it('fetches the ASA secret from Lithic once, or takes LITHIC_ASA_SECRET when set', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 1000)
    await asa(h, lithic, sampleAuthorization({ token: 'a1', cardToken: await tokenOf(h), amount: 1 }))
    await asa(h, lithic, sampleAuthorization({ token: 'a2', cardToken: await tokenOf(h), amount: 1 }))
    expect(lithic.calls.filter((c) => c === 'authStreamSecret')).toHaveLength(1)

    const own = 'whsec_' + Buffer.from('env-secret').toString('base64')
    const w2 = await world({ env: { LITHIC_ASA_SECRET: own } })
    await cardWith(w2.h, w2.ana, 1000)
    const t = (w2.h.app.core.db.prepare('SELECT lithic_token AS t FROM card_cards').get() as { t: string }).t
    expect((await asa(w2.h, w2.lithic, sampleAuthorization({ token: 'b1', cardToken: t, amount: 1 }), { secret: own })).body.result).toBe('APPROVED')
    expect(w2.lithic.calls).not.toContain('authStreamSecret')
  })
})

describe('POST /v1/dev/card/simulate (DEMO_MODE)', () => {
  it('asks Lithic for a test purchase on the card, reads the decision, then clears it', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 2000)
    lithic.lagReads = 2 // the decision is not readable at once
    const ok = await h.json('POST', '/v1/dev/card/simulate', { token: ana.token, body: { amountMinor: 1200, merchantName: 'Sette Archi' } })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ approved: true, authorization: { amountMinor: 1200, merchant: 'Sette Archi', status: 'authorised' } })
    await h.settle()
    expect(lithic.calls).toContain('simulateClearing')
    expect((await h.json('GET', '/v1/card', { token: ana.token })).body.authorizations[0].status).toBe('completed')
    const no = await h.json('POST', '/v1/dev/card/simulate', { token: ana.token, body: { amountMinor: 1200, merchantName: 'Sette Archi' } })
    expect(no.body).toMatchObject({ approved: false, authorization: { status: 'declined' } })
  })

  it('does not exist without DEMO_MODE', async () => {
    const { h, ana } = await world({ env: { DEMO_MODE: '0' } })
    expect((await h.json('POST', '/v1/dev/card/simulate', { token: ana.token, body: { amountMinor: 100, merchantName: 'X' } })).status).toBe(404)
  })
})

describe('POST /v1/demo/shop/charge (the demo shop’s "Pay by card")', () => {
  it('checks expiry and code against the card, simulates the purchase as SETTE ARCHI, returns the receipt, then settles', async () => {
    const { h, lithic, ana } = await world()
    const card = await cardWith(h, ana, 2000)
    const o = await order(h)
    const s = await secretOf(h, ana)
    const r = await h.json('POST', '/v1/demo/shop/charge', { body: { orderId: o.orderId, pan: s.pan, expMonth: s.expMonth, expYear: s.expYear, cvc: s.cvc } })
    expect(r.status).toBe(200)
    expect(ShopChargeResponse.safeParse(r.body).success).toBe(true)
    expect(r.body.approved).toBe(true)
    expect(r.body.receipt).toMatchObject({
      shopName: 'Sette Archi',
      amountMinor: 1450,
      method: 'card',
      cardLast4: card.last4,
      status: 'authorised',
      items: [{ name: 'Etiopia Guji, 250 g', qty: 1, unitMinor: 1450 }],
    })
    expect(r.body.receipt.orderNumber).toMatch(/^SA-\d+$/)
    const tx = lithic.txs.get(r.body.receipt.reference)!
    expect(tx).toMatchObject({ amount: 1450, merchant: { descriptor: 'SETTE ARCHI' } })
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(550)
    await h.settle()
    expect(lithic.calls).toContain('simulateClearing')
    expect(cardChargeForOrder(h.app.core, o.orderId)?.receipt.status).toBe('completed')
    expect(events(h, ana.user.id, 'card.authorization').map((a) => a.status)).toEqual(['authorised', 'completed'])
    // Paid once: a second charge of the same order is refused.
    const again = await h.json('POST', '/v1/demo/shop/charge', { body: { orderId: o.orderId, pan: s.pan, expMonth: s.expMonth, expYear: s.expYear, cvc: s.cvc } })
    expect([again.status, again.body.error.code]).toEqual([409, 'already_paid'])
  })

  it('declines above the card balance: "Card declined. Try another payment method."', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 2000)
    const o = await order(h, [{ sku: 'grinder', qty: 1 }])
    const s = await secretOf(h, ana)
    const r = await h.json('POST', '/v1/demo/shop/charge', { body: { orderId: o.orderId, pan: s.pan, expMonth: s.expMonth, expYear: s.expYear, cvc: s.cvc } })
    expect(r.body).toEqual({ approved: false, message: 'Card declined. Try another payment method.' })
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2000)
    expect(events(h, ana.user.id, 'card.authorization').at(-1)).toMatchObject({ approved: false, declineReason: 'Declined, not enough on the card' })
  })

  it('declines a wrong code or expiry without asking Lithic for a purchase', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 2000)
    const o = await order(h)
    const s = await secretOf(h, ana)
    const wrongCvc = s.cvc === '999' ? '998' : '999'
    for (const body of [
      { orderId: o.orderId, pan: s.pan, expMonth: s.expMonth, expYear: s.expYear, cvc: wrongCvc },
      { orderId: o.orderId, pan: s.pan, expMonth: (s.expMonth % 12) + 1, expYear: s.expYear, cvc: s.cvc },
      { orderId: o.orderId, pan: '4000000000000002', expMonth: s.expMonth, expYear: s.expYear, cvc: s.cvc },
    ]) {
      const r = await h.json('POST', '/v1/demo/shop/charge', { body })
      expect(r.body).toEqual({ approved: false, message: 'Card declined. Try another payment method.' })
    }
    expect(lithic.calls).not.toContain('simulateAuthorize')
  })

  it('accepts a two-digit year', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 2000)
    const o = await order(h)
    const s = await secretOf(h, ana)
    const r = await h.json('POST', '/v1/demo/shop/charge', { body: { orderId: o.orderId, pan: s.pan, expMonth: s.expMonth, expYear: s.expYear % 100, cvc: s.cvc } })
    expect(r.body.approved).toBe(true)
  })

  it('a decision that could not be read is not charged twice: a retry of the same order picks up the first purchase', async () => {
    const { h, lithic, ana } = await world({ card: { decisionTimeoutMs: 300 } })
    await cardWith(h, ana, 4000)
    const o = await order(h)
    const s = await secretOf(h, ana)
    lithic.lagReads = 1000 // our webhook approves, but the decision cannot be read in time
    const r1 = await payByCard(h, o.orderId, s)
    expect([r1.status, r1.body.error.code]).toEqual([502, 'upstream_error'])
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2550)
    lithic.lagReads = 0
    const r2 = await payByCard(h, o.orderId, s)
    expect(r2.body.approved).toBe(true)
    await h.settle()
    expect(lithic.calls.filter((c) => c === 'simulateAuthorize')).toHaveLength(1)
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2550)
    expect(cardChargeForOrder(h.app.core, o.orderId)).toMatchObject({ authToken: r2.body.receipt.reference, receipt: { status: 'completed' } })
    expect(h.app.core.db.prepare('SELECT status FROM card_holds').all()).toEqual([{ status: 'completed' }])
  })

  it('404 for an unknown order', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 0)
    const s = await secretOf(h, ana)
    const r = await h.json('POST', '/v1/demo/shop/charge', { body: { orderId: 'ord_nope', pan: s.pan, expMonth: s.expMonth, expYear: s.expYear, cvc: s.cvc } })
    expect(r.status).toBe(404)
  })
})

describe('our webhook approved, Lithic still declined (the answer arrived late or was lost)', () => {
  it('the shop says declined, the money goes back to the card, the order stays unpaid and nothing settles', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 2000)
    const o = await order(h)
    const s = await secretOf(h, ana)
    lateAnswers(lithic)
    const r = await payByCard(h, o.orderId, s)
    expect(r.body).toEqual({ approved: false, message: DECLINED_COPY })
    await h.settle()
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2000)
    expect(events(h, ana.user.id, 'card.authorization').at(-1)).toMatchObject({ amountMinor: 1450, status: 'voided' })
    expect(cardChargeForOrder(h.app.core, o.orderId)).toBeUndefined()
    expect(h.pool.payouts).toHaveLength(0)
  })

  it('the test purchase says declined and gives the money back', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 2000)
    lateAnswers(lithic)
    const r = await h.json('POST', '/v1/dev/card/simulate', { token: ana.token, body: { amountMinor: 100, merchantName: 'Sette Archi' } })
    expect(r.body).toMatchObject({ approved: false, authorization: { status: 'voided' } })
    await h.settle()
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2000)
    expect(h.pool.payouts).toHaveLength(0)
  })

  it('the poller gives the money back for a purchase Lithic declined after our approval', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 2000)
    const pan = (await secretOf(h, ana)).pan
    lateAnswers(lithic)
    const { token } = await lithic.simulateAuthorize({ amount: 500, descriptor: 'CAFFE BRUNO', pan })
    expect(lithic.txs.get(token)).toMatchObject({ status: 'DECLINED', result: 'DECLINED' })
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(1500)
    await cardSync(h.app.core)
    await h.settle()
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2000)
    expect(holdRow(h, token)?.status).toBe('voided')
    expect(events(h, ana.user.id, 'card.authorization').at(-1)).toMatchObject({ id: token, status: 'voided' })
    expect(h.pool.payouts).toHaveLength(0)
  })
})

describe('after the purchase: clearing, voids and returns from Lithic (poller)', () => {
  it('a void gives the money back to the card; a clearing completes; a return is credited once', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 3000)
    const a = await h.json('POST', '/v1/dev/card/simulate', { token: ana.token, body: { amountMinor: 1000, merchantName: 'Sette Archi' } })
    await h.settle()
    // The dev route clears its own purchases; take a fresh one straight from Lithic for the void.
    const pan = (await secretOf(h, ana)).pan
    const { token } = await lithic.simulateAuthorize({ amount: 500, descriptor: 'CAFFE BRUNO', pan })
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(1500)
    await lithic.simulateVoid({ token })
    await cardSync(h.app.core)
    expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2000)
    expect(events(h, ana.user.id, 'card.authorization').at(-1)).toMatchObject({ id: token, status: 'voided' })

    const { token: t2 } = await lithic.simulateAuthorize({ amount: 300, descriptor: 'CAFFE BRUNO', pan })
    await lithic.simulateClearing({ token: t2 })
    await lithic.simulateReturn({ amount: 250, descriptor: 'SETTE ARCHI', pan })
    await cardSync(h.app.core)
    await cardSync(h.app.core)
    const d = (await h.json('GET', '/v1/card', { token: ana.token })).body
    expect(d.balanceMinor).toBe(2000 - 300 + 250)
    expect(d.authorizations.map((x: any) => x.status)).toEqual(['refunded', 'completed', 'voided', 'completed'])
    expect(a.body.approved).toBe(true)
  })
})

describe('integration: the real mock ledger and pool worker', () => {
  it('load through the pool, an approved purchase settled pool -> card settlement on the ledger', async () => {
    const { createMockEnvironment } = await import('@zecca/ledger-mock')
    const { createMemoryPoolStore, createPoolWorker } = await import('@zecca/pool-worker')
    const { eventually } = await import('../../testing/harness')
    const env = createMockEnvironment()
    const pool = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, pollMs: 1e9, lagMonitor: false })
    const h = makeHarness({ env: { FEATURE_CARD: '1' }, ledger: env.ledger as never, keystore: env.keystore, pool: pool as never })
    const lithic = createFakeLithic()
    mountCard(h.app, h.app.core, { lithic, simulateGapMs: 0, pollMs: 0 })
    registerCard(h.app.core)
    lithic.asa = async (body) => (await asa(h, lithic, body)).body.result
    await pool.start()
    const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
    users.setTier(h.app.core, ana.user.id, 1)
    await h.json('POST', '/v1/card', { token: ana.token })
    const l = await h.json('POST', '/v1/card/load', { token: ana.token, body: { amountMinor: 2000 } })
    expect((await h.submit(ana, l.body.prepared)).body.status).toBe('validated')
    await eventually(() => expect(cardBalanceOf(h.app.core, ana.user.id)).toBe(2000), 5000)
    const settlement = env.keystore.getWallet('cardSettlement').address
    const before = env.ledger.mock.balances(settlement).spendableMinor + env.ledger.mock.balances(settlement).inboxMinor
    const r = await h.json('POST', '/v1/dev/card/simulate', { token: ana.token, body: { amountMinor: 1200, merchantName: 'Sette Archi' } })
    expect(r.body.approved).toBe(true)
    await eventually(() => {
      const b = env.ledger.mock.balances(settlement)
      expect(b.spendableMinor + b.inboxMinor - before).toBe(1200)
    }, 5000)
    expect(env.ledger.mock.balances(ana.user.address).spendableMinor).toBe(3000)
    await h.app.core.idle()
    await pool.stop()
  })
})
