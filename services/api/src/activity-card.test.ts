// Card purchases in the cardholder's activity (GET /v1/activity) and the card part of GET /v1/balance.
// The purchases live in the card connector's sub-ledger; the API's books show them with their receipt.
import xrpl from 'xrpl'
import { describe, expect, it } from 'vitest'
import { Activity, ActivityPage, Balance, type ZeccaEvent } from '@zecca/contracts'
import { makeHarness, type TestUser } from './testing/harness'
import { users } from './users'
import { createFakeLithic } from './connectors/card/fake-lithic'
import { cardSync, mountCard, registerCard } from './connectors/card'
import { cardCtx } from './connectors/card/context'
import { signHeaders } from './connectors/card/lithic-sig'

type H = ReturnType<typeof makeHarness>

async function world(env: Record<string, string> = {}) {
  const h = makeHarness({ env: { FEATURE_CARD: '1', ...env } })
  const w = xrpl.Wallet.generate('ecdsa-secp256k1' as never)
  h.keystore.setWallet('cardSettlement', { address: w.classicAddress, seed: w.seed!, algorithm: 'ecdsa-secp256k1' })
  const lithic = createFakeLithic()
  mountCard(h.app, h.app.core, { lithic, simulateGapMs: 0, pollMs: 0 })
  registerCard(h.app.core)
  lithic.asa = async (body) => {
    const raw = JSON.stringify(body)
    const headers = signHeaders(raw, lithic.secret, { ts: Math.floor(h.clock.now / 1000) })
    const res = await h.call('POST', '/v1/webhooks/lithic/asa', { body: raw, headers: { 'content-type': 'application/json', ...headers } })
    return (await res.json()).result
  }
  const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
  users.setTier(h.app.core, ana.user.id, 1)
  return { h, lithic, ana }
}

async function cardWith(h: H, ana: TestUser, loadMinor: number) {
  const c = await h.json('POST', '/v1/card', { token: ana.token })
  expect(c.status).toBe(200)
  const l = await h.json('POST', '/v1/card/load', { token: ana.token, body: { amountMinor: loadMinor } })
  expect((await h.submit(ana, l.body.prepared)).body.status).toBe('validated')
  await h.settle()
  return c.body as { last4: string }
}

const activity = async (h: H, u: TestUser) => {
  const r = await h.json('GET', '/v1/activity', { token: u.token })
  expect(r.status).toBe(200)
  return ActivityPage.parse(r.body).items
}
const purchases = async (h: H, u: TestUser) => (await activity(h, u)).filter((a) => a.kind === 'card_purchase')
/** A card with money and an approved purchase, written straight into the card store (works with the card feature off). */
function cardInStore(h: H, u: TestUser) {
  const store = cardCtx(h.app.core).store
  store.linkCard(u.user.id, { id: 'card_1', token: 'lc_1', last4: '4417', expMonth: 11, expYear: 2029, state: 'OPEN', holderName: 'Ana Ferri' })
  store.creditDeposit({ intentId: 'int_load_1', userId: u.user.id, amountMinor: 1000 })
  expect(store.authorize({ authToken: 'auth_off_1', userId: u.user.id, cardToken: 'lc_1', amountMinor: 400, merchant: 'Bar Roma' }).approved).toBe(true)
}
const simulate = (h: H, u: TestUser, amountMinor: number, merchantName = 'Sette Archi') =>
  h.json('POST', '/v1/dev/card/simulate', { token: u.token, body: { amountMinor, merchantName } })

describe('card purchases in GET /v1/activity', () => {
  it('shows a purchase with its card receipt: authorised (pending), then completed (done)', async () => {
    const { h, ana } = await world()
    const card = await cardWith(h, ana, 2000)
    // Seen while authorised: settle nothing yet (the clearing runs in the background).
    const r = await simulate(h, ana, 1200)
    expect(r.body.approved).toBe(true)
    const first = (await purchases(h, ana))[0]
    expect(first).toMatchObject({ kind: 'card_purchase', direction: 'out', amountMinor: 1200, feeMinor: 0, intentId: r.body.authorization.id })
    expect(first.receipt).toMatchObject({ method: 'card', cardLast4: card.last4, shopName: 'Sette Archi', amountMinor: 1200, reference: r.body.authorization.id })
    expect(['authorised', 'completed']).toContain(first.receipt!.status)
    await h.settle()
    const done = (await purchases(h, ana))[0]
    expect(done).toMatchObject({ id: first.id, status: 'done', receipt: { status: 'completed' } })
    // Newest first, above the card load.
    expect((await activity(h, ana)).map((a) => a.kind).slice(0, 2)).toEqual(['card_purchase', 'card_load'])
    // One row per purchase, whatever the number of events.
    expect(await purchases(h, ana)).toHaveLength(1)
    // By id and by authorization (its intentId), like every activity.
    expect(Activity.parse((await h.json('GET', `/v1/activity/${done.id}`, { token: ana.token })).body).receipt?.status).toBe('completed')
    expect((await h.json('GET', `/v1/activity/${done.intentId}`, { token: ana.token })).body.id).toBe(done.id)
  })

  it('links the settlement payment out of the pool once the purchase cleared', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 2000)
    await simulate(h, ana, 500)
    await h.settle()
    const p = (await purchases(h, ana))[0]
    expect(p.ledger.network).toBe('devnet')
    expect(p.ledger.payoutTxHash).toMatch(/^[0-9A-F]{64}$/)
    expect(p.ledger.depositTxHash).toBeUndefined()
  })

  it('shows a declined purchase as failed, with the reason', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 1000)
    const r = await simulate(h, ana, 5000)
    expect(r.body.approved).toBe(false)
    const p = (await purchases(h, ana))[0]
    expect(p).toMatchObject({ status: 'failed', amountMinor: 5000, note: 'Declined, not enough on the card', receipt: { status: 'declined' } })
  })

  it('shows a voided purchase as failed: the money went back to the card', async () => {
    const { h, lithic, ana } = await world()
    await cardWith(h, ana, 2000)
    lithic.failNext('simulateClearing')
    const r = await simulate(h, ana, 700)
    await h.settle()
    await lithic.simulateVoid({ token: r.body.authorization.id })
    await cardSync(h.app.core)
    await h.settle()
    const p = (await purchases(h, ana))[0]
    expect(p.status).toBe('failed')
    // The shop's name stays (a void has no receipt), and the copy holds for an expiry or a late decline too.
    expect(p.note).toBe('Sette Archi: cancelled. The money is back on your card.')
  })

  it('pushes the row live (activity.created) at the purchase and again when it completes', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 2000)
    const r = await simulate(h, ana, 300)
    await h.settle()
    const pushed = h.app.core.bus
      .history()
      .filter((x) => x.to === `user:${ana.user.id}` && x.event.type === 'activity.created')
      .map((x) => (x.event as Extract<ZeccaEvent, { type: 'activity.created' }>).data)
      .filter((a) => a.intentId === r.body.authorization.id)
    expect(pushed.length).toBeGreaterThanOrEqual(2)
    expect(new Set(pushed.map((a) => a.id)).size).toBe(1)
    expect(pushed.at(-1)).toMatchObject({ status: 'done', receipt: { status: 'completed' } })
    for (const a of pushed) expect(Activity.safeParse(a).success).toBe(true)
  })

  it('shows the demo shop receipt (order number and items) for a shop purchase by card', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 2000)
    const o = (await h.json('POST', '/v1/demo/shop/orders', { body: { items: [{ sku: 'guji-250', qty: 1 }] } })).body
    const s = (await h.json('GET', '/v1/card/secret', { token: ana.token })).body
    const r = await h.json('POST', '/v1/demo/shop/charge', { body: { orderId: o.orderId, pan: s.pan, expMonth: s.expMonth, expYear: s.expYear, cvc: s.cvc } })
    expect(r.body.approved).toBe(true)
    await h.settle()
    const p = (await purchases(h, ana))[0]
    expect(p.receipt).toMatchObject({ orderNumber: r.body.receipt.orderNumber, items: [{ name: 'Etiopia Guji, 250 g', qty: 1, unitMinor: 1450 }], status: 'completed', method: 'card' })
  })

  it('picks up purchases recorded before the activity row existed, and never shows another person\'s', async () => {
    const { h, ana } = await world()
    await cardWith(h, ana, 2000)
    const card = cardCtx(h.app.core).store.cardOf(ana.user.id)!
    cardCtx(h.app.core).store.authorize({ authToken: 'old-auth-1', userId: ana.user.id, cardToken: card.token, amountMinor: 250, merchant: 'Bar Roma' })
    const carla = await h.signUp('carla')
    expect(await purchases(h, carla)).toEqual([])
    expect((await purchases(h, ana)).map((a) => [a.intentId, a.amountMinor, a.receipt?.shopName])).toEqual([['old-auth-1', 250, 'Bar Roma']])
  })

  it('shows nothing of the card while the card feature is off', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    cardInStore(h, ana)
    expect((await activity(h, ana)).some((a) => a.kind === 'card_purchase')).toBe(false)
  })
})

describe('GET /v1/balance with a card', () => {
  it('carries cardMinor once the person has a card', async () => {
    const { h, ana } = await world()
    expect(Balance.parse((await h.json('GET', '/v1/balance', { token: ana.token })).body).cardMinor).toBeUndefined()
    await cardWith(h, ana, 1500)
    expect(Balance.parse((await h.json('GET', '/v1/balance', { token: ana.token })).body).cardMinor).toBe(1500)
    await simulate(h, ana, 400)
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.cardMinor).toBe(1100)
  })

  it('has no cardMinor while the card feature is off', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    cardInStore(h, ana)
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.cardMinor).toBeUndefined()
  })
})
