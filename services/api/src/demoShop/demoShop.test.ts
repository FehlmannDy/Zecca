// Demo shop routes (SPEC §4.14, §6.3) against their schemas: catalogue, order -> payment request for the seeded
// Sette Archi merchant, order status from the request, the receipt on the buyer's activity once paid.
import { describe, expect, it } from 'vitest'
import { Activity, PaymentRequest, ShopItem, ShopOrder, ShopOrderCreated, feeMinor } from '@zecca/contracts'
import { shopItems } from '@zecca/contracts/fixtures'
import { createFakePool, type FakeLedger, type FakePool } from '../testing/fakes'
import { eventually, makeHarness } from '../testing/harness'
import { seedDemoShop } from '../seed'
import { priceOrder } from './catalog'
import { cardCtx } from '../connectors/card/context'

async function world(o: { env?: Record<string, string>; pool?: FakePool; seed?: boolean } = {}) {
  const h = makeHarness<FakeLedger, FakePool>({ env: o.env, pool: o.pool })
  const shopId = o.seed === false ? undefined : await seedDemoShop(h.app.core)
  return { h, shopId }
}

const order = (h: Awaited<ReturnType<typeof world>>['h'], items: Array<{ sku: string; qty: number }>) =>
  h.json('POST', '/v1/demo/shop/orders', { body: { items } })

describe('demo shop: catalogue', () => {
  it('GET /v1/demo/shop/items serves the fixtures catalogue, public', async () => {
    const { h } = await world()
    const r = await h.json('GET', '/v1/demo/shop/items')
    expect(r.status).toBe(200)
    expect(r.body.map((i: unknown) => ShopItem.parse(i))).toEqual(shopItems)
  })

  it('is off without DEMO_MODE (404) and off with the demoShop flag down (feature_off)', async () => {
    const off = makeHarness({ env: { DEMO_MODE: '0' } })
    expect((await off.json('GET', '/v1/demo/shop/items')).status).toBe(404)
    const flagOff = makeHarness({ env: { FEATURE_DEMO_SHOP: '0' } })
    const r = await flagOff.json('GET', '/v1/demo/shop/items')
    expect(r.status).toBe(404)
    expect(r.body.error.code).toBe('feature_off')
  })

  it('priceOrder: sums integer cents, merges repeated skus, refuses unknown ones', () => {
    expect(priceOrder([{ sku: 'guji-250', qty: 2 }, { sku: 'moka-3', qty: 1 }, { sku: 'guji-250', qty: 1 }])).toEqual({
      amountMinor: 1450 * 3 + 3200,
      lines: [
        { sku: 'guji-250', name: 'Etiopia Guji, 250 g', qty: 3, unitMinor: 1450 },
        { sku: 'moka-3', name: 'Moka pot, 3 cups', qty: 1, unitMinor: 3200 },
      ],
    })
    expect(() => priceOrder([{ sku: 'nope', qty: 1 }])).toThrow(/isn't in the shop/)
  })
})

describe('demo shop: orders', () => {
  it('POST /orders creates a payment request for Sette Archi through the normal code (public)', async () => {
    const { h, shopId } = await world()
    const r = await order(h, [{ sku: 'guji-250', qty: 1 }, { sku: 'huila-250', qty: 2 }])
    expect(r.status).toBe(200)
    const created = ShopOrderCreated.parse(r.body)
    expect(created.amountMinor).toBe(1450 + 2 * 1250)
    expect(created.paymentRequest).toMatchObject({ merchantId: shopId, merchantName: 'Sette Archi', amountMinor: 3950, status: 'created' })
    expect(created.paymentRequest.url).toBe(`http://localhost:3100/pay/${created.paymentRequest.id}`)
    expect(created.paymentRequest.reference).toMatch(/^Order SA-\d{4}$/)
    // The same request the till would have made: readable on the public route.
    const pr = PaymentRequest.parse((await h.json('GET', `/v1/payment-requests/${created.paymentRequest.id}`)).body)
    expect(pr.amountMinor).toBe(3950)
  })

  it('order numbers count up from SA-1001', async () => {
    const { h } = await world()
    const a = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)
    const b = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)
    expect(a.paymentRequest.reference).toBe('Order SA-1001')
    expect(b.paymentRequest.reference).toBe('Order SA-1002')
  })

  it('refuses unknown items and bad bodies with a 400 and an English message', async () => {
    const { h } = await world()
    const r = await order(h, [{ sku: 'espresso-machine', qty: 1 }])
    expect(r.status).toBe(400)
    expect(r.body.error.message).toBe("espresso-machine isn't in the shop.")
    expect((await order(h, [])).status).toBe(400)
    expect((await order(h, [{ sku: 'guji-250', qty: 0 }])).status).toBe(400)
  })

  it('seeds the shop on first use when the server did not, and never creates a second one', async () => {
    const { h } = await world({ seed: false })
    const r = await order(h, [{ sku: 'moka-3', qty: 1 }])
    expect(r.status).toBe(200)
    const again = await order(h, [{ sku: 'moka-3', qty: 1 }])
    expect(again.body.paymentRequest.merchantId).toBe(r.body.paymentRequest.merchantId)
    expect(h.app.core.db.prepare("SELECT COUNT(*) AS n FROM users WHERE handle = 'settearchi'").get()).toEqual({ n: 1 })
  })

  it('without a demoShop wallet the order fails with a clear 502 (upstream_error) message', async () => {
    const h = makeHarness()
    h.app.core.keystore.hasWallet = () => false
    const r = await order(h as never, [{ sku: 'moka-3', qty: 1 }])
    expect(r.status).toBe(502)
    expect(r.body.error.message).toBe('The demo shop is closed right now. Try again later.')
  })

  it('GET /orders/:id: pending, then paid with the receipt; the buyer activity carries it (method zecca, completed)', async () => {
    const pool = createFakePool({ auto: false })
    const { h, shopId } = await world({ pool })
    const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
    const created = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)

    let o = ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body)
    expect(o).toMatchObject({ id: created.orderId, status: 'pending', amountMinor: 1450, paymentRequestId: created.paymentRequest.id })
    expect(o.items).toEqual([{ sku: 'guji-250', name: 'Etiopia Guji, 250 g', qty: 1, unitMinor: 1450 }])
    expect(o.receipt).toBeUndefined()
    // Reading the order does not mark the request opened (only the customer's pay page does).
    expect(h.app.core.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(created.paymentRequest.id)).toEqual({ status: 'created' })

    const pay = await h.json('POST', `/v1/payment-requests/${created.paymentRequest.id}/pay`, { token: ana.token })
    expect(pay.status).toBe(200)
    expect(pay.body.intent).toMatchObject({ toUserId: shopId, amountMinor: 1450, feeMinor: feeMinor(1450, 50) })
    const s = await h.submit(ana, pay.body.prepared)
    expect(s.body.status).toBe('validated')
    pool.emit({ type: 'received', intentId: pay.body.intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 1450 })

    o = await eventually(async () => {
      const x = ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body)
      expect(x.status).toBe('paid')
      return x
    })
    expect(o.method).toBe('zecca')
    expect(o.receipt).toMatchObject({
      orderNumber: 'SA-1001',
      shopName: 'Sette Archi',
      items: [{ name: 'Etiopia Guji, 250 g', qty: 1, unitMinor: 1450 }],
      amountMinor: 1450,
      method: 'zecca',
      status: 'completed',
      reference: created.paymentRequest.id,
    })

    const items = (await h.json('GET', '/v1/activity', { token: ana.token })).body.items.map((a: unknown) => Activity.parse(a))
    const buy = items.find((a: Activity) => a.intentId === pay.body.intent.id)!
    expect(buy).toMatchObject({ direction: 'out', kind: 'merchant', amountMinor: 1450, counterparty: { handle: 'settearchi' } })
    expect(buy.receipt).toEqual(o.receipt)
    // Pushed live too: the buyer's home replaces the row by id.
    const pushed = h.app.core.bus
      .history()
      .filter((x) => x.to === `user:${ana.user.id}` && x.event.type === 'activity.created')
      .map((x) => x.event.data as Activity)
    expect(pushed.at(-1)?.receipt?.orderNumber).toBe('SA-1001')
  })

  it('attaches the receipt on read when the live hook left none, and only once', async () => {
    const pool = createFakePool({ auto: false })
    const { h } = await world({ pool })
    const ana = await h.signUp('ana')
    const created = ShopOrderCreated.parse((await order(h, [{ sku: 'huila-250', qty: 1 }])).body)
    const pay = await h.json('POST', `/v1/payment-requests/${created.paymentRequest.id}/pay`, { token: ana.token })
    const s = await h.submit(ana, pay.body.prepared)
    pool.emit({ type: 'received', intentId: pay.body.intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 1250 })
    await eventually(async () => expect((await h.json('GET', `/v1/payment-requests/${created.paymentRequest.id}`)).body.status).toBe('paid'))
    // Simulate the missed hook: wipe the receipt, then read the order.
    h.app.core.db.prepare('UPDATE activities SET receipt_json = NULL').run()
    const o = ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body)
    expect(o.status).toBe('paid')
    const buy = (await h.json('GET', '/v1/activity', { token: ana.token })).body.items[0]
    expect(buy.receipt.orderNumber).toBe('SA-1001')
    // A second read changes nothing and pushes nothing again.
    const pushes = () => h.app.core.bus.history().filter((x) => x.to === `user:${ana.user.id}` && x.event.type === 'activity.created').length
    const before = pushes()
    expect(ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body).receipt?.orderNumber).toBe('SA-1001')
    expect(pushes()).toBe(before)
    expect((await h.json('GET', '/v1/activity', { token: ana.token })).body.items[0].receipt).toEqual(buy.receipt)
  })

  it('reading an order whose request ran out tells the request stream it expired and drops the order watcher', async () => {
    const { h } = await world()
    const created = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)
    const prId = created.paymentRequest.id
    expect(h.app.core.bus.listenerCount('request', prId)).toBe(1)
    h.clock.advance(h.app.core.settings.paymentRequestTtlMs + 60_000)
    expect((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).status).toBe(200)
    await h.app.jobs.tick()
    const expired = h.app.core.bus
      .history()
      .filter((x) => x.to === `request:${prId}` && x.event.type === 'payment_request.updated' && (x.event.data as PaymentRequest).status === 'expired')
    expect(expired).toHaveLength(1)
    expect(h.app.core.bus.listenerCount('request', prId)).toBe(0)
  })

  it('GET /orders/:id for an unknown order is a 404', async () => {
    const { h } = await world()
    const r = await h.json('GET', '/v1/demo/shop/orders/ord_nope')
    expect(r.status).toBe(404)
    expect(r.body.error.message).toBe("We couldn't find this order.")
  })
})

describe('demo shop: orders paid by card, and the payment request state', () => {
  /** A card payment of the order as the card connector records it (its sub-ledger), without Lithic. */
  function payByCard(h: Awaited<ReturnType<typeof world>>['h'], userId: string, orderId: string, amountMinor: number) {
    const store = cardCtx(h.app.core).store
    if (!store.cardOf(userId)) store.linkCard(userId, { id: 'card_1', token: 'lc_1', last4: '4417', expMonth: 11, expYear: 2029, state: 'OPEN', holderName: 'Ana Ferri' })
    store.creditDeposit({ intentId: `int_load_${orderId}`, userId, amountMinor })
    const authToken = `auth_${orderId}`
    expect(store.authorize({ authToken, userId, cardToken: 'lc_1', amountMinor, merchant: 'Sette Archi', orderId }).approved).toBe(true)
    const receipt = { orderNumber: 'SA-1001', shopName: 'Sette Archi', items: [{ name: 'Etiopia Guji, 250 g', qty: 1, unitMinor: 1450 }], amountMinor, method: 'card' as const, cardLast4: '4417', status: 'authorised' as const, at: h.app.core.iso(), reference: authToken }
    store.saveCharge(orderId, authToken, receipt)
    return { authToken, receipt }
  }

  it('GET /orders/:id carries the payment request status and expiry (pending, then expired)', async () => {
    const { h } = await world()
    const created = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)
    let o = ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body)
    expect(o).toMatchObject({ status: 'pending', paymentStatus: 'created', expiresAt: created.paymentRequest.expiresAt })
    h.clock.advance(h.app.core.settings.paymentRequestTtlMs + 1000)
    o = ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body)
    expect(o).toMatchObject({ status: 'pending', paymentStatus: 'expired' })
  })

  it('paid by card: status paid, method card, the card receipt', async () => {
    const { h } = await world({ env: { FEATURE_CARD: '1' } })
    const ana = await h.signUp('ana')
    const created = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)
    const { receipt } = payByCard(h, ana.user.id, created.orderId, 1450)
    const o = ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body)
    expect(o).toMatchObject({ status: 'paid', method: 'card', receipt, paymentRequestId: created.paymentRequest.id })
  })

  it('"Pay with Zecca" refuses an order already paid by card (409 already_paid)', async () => {
    const { h } = await world({ env: { FEATURE_CARD: '1' } })
    const ana = await h.signUp('ana')
    const created = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)
    payByCard(h, ana.user.id, created.orderId, 1450)
    const pay = await h.json('POST', `/v1/payment-requests/${created.paymentRequest.id}/pay`, { token: ana.token })
    expect([pay.status, pay.body.error.code]).toEqual([409, 'already_paid'])
    expect(pay.body.error.message).toBe('This order was already paid by card.')
    // A voided card purchase no longer stands: the order can be paid with Zecca again.
    cardCtx(h.app.core).store.voidHold(`auth_${created.orderId}`)
    expect(ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body).status).toBe('pending')
    expect((await h.json('POST', `/v1/payment-requests/${created.paymentRequest.id}/pay`, { token: ana.token })).status).toBe(200)
  })

  it('a Zecca payment prepared before the order was paid by card is refused at submit: the buyer never pays twice', async () => {
    const { h } = await world({ env: { FEATURE_CARD: '1' } })
    const ana = await h.signUp('ana')
    const created = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)
    const pay = await h.json('POST', `/v1/payment-requests/${created.paymentRequest.id}/pay`, { token: ana.token })
    expect(pay.status).toBe(200)
    const before = (await h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor
    const { authToken } = payByCard(h, ana.user.id, created.orderId, 1450)

    const s = await h.submit(ana, pay.body.prepared)
    expect([s.status, s.body.error?.code, s.body.error?.message]).toEqual([409, 'already_paid', 'This order was already paid by card.'])
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(before)
    expect(h.app.core.db.prepare('SELECT status, claimed_intent_id FROM payment_requests WHERE id = ?').get(created.paymentRequest.id)).toEqual({
      status: 'created',
      claimed_intent_id: null,
    })
    expect(ShopOrder.parse((await h.json('GET', `/v1/demo/shop/orders/${created.orderId}`)).body)).toMatchObject({ status: 'paid', method: 'card' })

    // Once the card purchase is voided, the same prepared payment can go through.
    cardCtx(h.app.core).store.voidHold(authToken)
    expect((await h.submit(ana, pay.body.prepared)).body.status).toBe('validated')
  })

  it('refuses a Zecca payment while a card payment of the order is on its way, or its approved purchase was not recorded yet', async () => {
    const { h } = await world({ env: { FEATURE_CARD: '1' } })
    const ana = await h.signUp('ana')
    const created = ShopOrderCreated.parse((await order(h, [{ sku: 'guji-250', qty: 1 }])).body)
    const pay = await h.json('POST', `/v1/payment-requests/${created.paymentRequest.id}/pay`, { token: ana.token })
    const ctx = cardCtx(h.app.core)

    ctx.charging.add(created.orderId)
    const inFlight = await h.submit(ana, pay.body.prepared)
    expect([inFlight.status, inFlight.body.error?.code]).toEqual([409, 'conflict'])
    expect(inFlight.body.error.message).toBe('This order is being paid by card. Wait a moment.')
    ctx.charging.delete(created.orderId)

    // Lithic approved the purchase but the shop did not record it yet (the buyer saw an error): the money is held.
    ctx.store.linkCard(ana.user.id, { id: 'card_1', token: 'lc_1', last4: '4417', expMonth: 11, expYear: 2029, state: 'OPEN', holderName: 'Ana Ferri' })
    ctx.store.creditDeposit({ intentId: 'int_load_1', userId: ana.user.id, amountMinor: 1450 })
    ctx.store.authorize({ authToken: 'auth_held', userId: ana.user.id, cardToken: 'lc_1', amountMinor: 1450, merchant: 'Sette Archi', orderId: created.orderId })
    const held = await h.submit(ana, pay.body.prepared)
    expect([held.status, held.body.error?.code]).toEqual([409, 'already_paid'])
    expect((await h.json('POST', `/v1/payment-requests/${created.paymentRequest.id}/pay`, { token: ana.token })).status).toBe(409)
  })

  it('leaves other payment requests alone', async () => {
    const { h } = await world({ env: { FEATURE_CARD: '1' } })
    const ana = await h.signUp('ana')
    const bruno = await h.signUp('bruno', { role: 'merchant', businessName: 'Bar Bruno' })
    const pr = await h.json('POST', '/v1/payment-requests', { token: bruno.token, body: { amountMinor: 300 } })
    expect((await h.json('POST', `/v1/payment-requests/${pr.body.id}/pay`, { token: ana.token })).status).toBe(200)
  })
})
