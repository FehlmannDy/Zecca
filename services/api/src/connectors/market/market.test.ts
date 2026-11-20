import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { decode } from 'ripple-binary-codec'
import { MarketAssetsResponse, MarketOrderResponse, HoldingsResponse, type MetalSymbol } from '@zecca/contracts'
import type { Env } from '../../config'
import { users } from '../../users'
import { fakeKeyStore, type FakeLedger, type FakePool } from '../../testing/fakes'
import { eventually, makeHarness, type Harness, type TestUser } from '../../testing/harness'
import { createFixtureFeed } from './feed'
import { issuanceIdFrom, metaKey } from './metals'
import { marketTick, mountMarket, registerMarket } from './index'

type H = Harness<FakeLedger, FakePool>

/** The fake ledger with public MPT balances: issuer payments mint, payments to the issuer burn. */
function withMetals(h: H, issuer: string) {
  const bal = new Map<string, number>()
  const key = (a: string, iss: string) => `${a}|${iss}`
  const payments: Array<{ from: string; to: string; iss: string; mg: number }> = []
  const apply = (tx: Record<string, unknown>): string | null => {
    const amt = tx.Amount as { mpt_issuance_id?: string; value?: string } | undefined
    if (tx.TransactionType !== 'Payment' || !amt?.mpt_issuance_id) return null
    const iss = amt.mpt_issuance_id.toUpperCase()
    const mg = Number(amt.value)
    const from = String(tx.Account)
    const to = String(tx.Destination)
    if (from !== issuer) {
      if ((bal.get(key(from, iss)) ?? 0) < mg) return 'tecINSUFFICIENT_FUNDS'
      bal.set(key(from, iss), (bal.get(key(from, iss)) ?? 0) - mg)
    }
    if (to !== issuer) bal.set(key(to, iss), (bal.get(key(to, iss)) ?? 0) + mg)
    payments.push({ from, to, iss, mg })
    return 'tesSUCCESS'
  }
  let failDeliveries = 0
  let lose: { applied: boolean; throws?: boolean } | undefined
  const submitAs = h.ledger.submitAs.bind(h.ledger)
  h.ledger.submitAs = async (role, tx) => {
    const r = await submitAs(role, tx)
    if (tx.TransactionType === 'Payment' && failDeliveries > 0) {
      failDeliveries--
      return { ...r, validated: true, engineResult: 'tecNO_AUTH' }
    }
    const lost = tx.TransactionType === 'Payment' ? lose : undefined
    if (lost) lose = undefined
    const res = lost && !lost.applied ? null : apply(tx)
    // What txByHash and accountTx read: the payments that reached the ledger.
    if (res === 'tesSUCCESS') h.ledger.applied.push({ hash: r.hash, ledgerIndex: h.ledger.index, validated: true, engineResult: res, tx })
    // A lost answer, like the live client: SUBMIT_ERROR (the tx may have validated), or a throw.
    if (lost?.throws) throw new Error('socket hang up')
    if (lost) return { validated: false, engineResult: 'SUBMIT_ERROR', hash: r.hash }
    return res && res !== 'tesSUCCESS' ? { ...r, validated: true, engineResult: res } : r
  }
  const submitUserSigned = h.ledger.submitUserSigned.bind(h.ledger)
  h.ledger.submitUserSigned = async (blob) => {
    const r = await submitUserSigned(blob)
    if (!r.validated) return r
    const res = apply(decode(blob) as Record<string, unknown>)
    return res && res !== 'tesSUCCESS' ? { ...r, validated: true, engineResult: res } : r
  }
  h.ledger.mptBalance = async (address, iss) => bal.get(key(address, iss.toUpperCase())) ?? 0
  return {
    payments,
    failNextDeliveries(n: number) {
      failDeliveries = n
    },
    /** The next metal payment loses its answer; it is on the ledger afterwards only when `applied`. */
    loseNextDelivery(o: { applied: boolean; throws?: boolean }) {
      lose = o
    },
  }
}

function setup(o: { env?: Env; mount?: boolean } = {}) {
  const keystore = fakeKeyStore()
  for (const role of ['marketIssuer', 'oracle'] as const) {
    const w = xrpl.Wallet.generate('ecdsa-secp256k1' as never)
    keystore.setWallet(role, { address: w.classicAddress, seed: w.seed!, algorithm: 'ecdsa-secp256k1' })
  }
  const issuer = keystore.getWallet('marketIssuer').address
  const ids: Record<MetalSymbol, string> = { XAU: issuanceIdFrom(1, issuer), XAG: issuanceIdFrom(2, issuer), XPD: issuanceIdFrom(3, issuer) }
  for (const [s, id] of Object.entries(ids)) keystore.setMeta(metaKey(s as MetalSymbol), id)
  const h = makeHarness<FakeLedger, FakePool>({ env: { FEATURE_MARKET: '1', ...o.env }, keystore })
  const metals = withMetals(h, issuer)
  if (o.mount !== false) {
    mountMarket(h.app, h.app.core)
    registerMarket(h.app.core, { feed: createFixtureFeed(), retryMs: 1, tickMs: 0 })
  }
  return { h, metals, ids, issuer }
}

async function verifiedUser(h: H, handle: string, creditMinor = 10_000): Promise<TestUser> {
  const u = await h.signUp(handle)
  users.setTier(h.app.core, u.user.id, 1)
  if (creditMinor) {
    const c = await h.json('POST', '/v1/dev/credit', { token: u.token, body: { amountMinor: creditMinor } })
    expect(c.status).toBe(200)
    await h.settle()
  }
  return u
}

const balanceOf = async (h: H, u: TestUser) => (await h.json('GET', '/v1/balance', { token: u.token })).body.availableMinor as number

/** Buys through the two approvals of a first purchase (authorize, then the send). Returns the second order. */
async function buy(h: H, u: TestUser, body: Record<string, unknown>) {
  let o = await h.json('POST', '/v1/market/orders', { token: u.token, body: { side: 'buy', ...body } })
  expect(o.status, JSON.stringify(o.body)).toBe(200)
  if (o.body.prepared.kind === 'market_authorize') {
    const a = await h.submit(u, o.body.prepared)
    expect(a.body.status).toBe('validated')
    o = await h.json('POST', '/v1/market/orders', { token: u.token, body: { side: 'buy', ...body } })
    expect(o.status).toBe(200)
  }
  expect(o.body.prepared.kind).toBe('send')
  const s = await h.submit(u, o.body.prepared)
  expect(s.body.status).toBe('validated')
  await h.settle()
  return o.body
}

describe('market connector (SPEC §4.9, §6.3)', () => {
  it('registers once per app, however often registerMarket is called', async () => {
    const { h } = setup()
    const before = h.app.core.submitHandlers.get('market_sell')
    registerMarket(h.app.core, { feed: createFixtureFeed() })
    expect(h.app.core.submitHandlers.get('market_sell')).toBe(before)
  })

  it('is invisible with the flag off', async () => {
    const { h } = setup({ env: { FEATURE_MARKET: '0' } })
    const u = await h.signUp('ana')
    for (const [m, p] of [
      ['GET', '/v1/market/assets'],
      ['GET', '/v1/market/holdings'],
      ['POST', '/v1/market/orders'],
      ['POST', '/v1/dev/market/tier'],
    ] as const) {
      const r = await h.json(m, p, { token: u.token, body: m === 'POST' ? { symbol: 'XAU', side: 'buy', amountMinor: 1000 } : undefined })
      expect(r.status, p).toBe(404)
      expect(r.body.error.code, p).toBe('feature_off')
    }
  })

  it('lists the three metals per gram with both prices, the source, the time and a real history', async () => {
    const { h } = setup()
    const u = await h.signUp('ana')
    const r = await h.json('GET', '/v1/market/assets', { token: u.token })
    expect(r.status).toBe(200)
    expect(MarketAssetsResponse.safeParse(r.body).success).toBe(true)
    expect(r.body.map((a: { symbol: string }) => a.symbol)).toEqual(['XAU', 'XAG', 'XPD'])
    const gold = r.body[0]
    expect(gold).toMatchObject({ name: 'Gold', unit: 'g', priceMinor: 11378, buyPriceMinor: 11435, sellPriceMinor: 11321, priceAt: '2026-11-20T21:59:57.000Z' })
    expect(gold.priceSource).toMatch(/Fixture/)
    expect(gold.history.at(-1)).toBe(11378)
    expect(gold.history.length).toBeGreaterThanOrEqual(2)
    expect(typeof gold.change24hPct).toBe('number')
  })

  it('needs a verified identity to trade (tier 0 gets the locked copy)', async () => {
    const { h } = setup()
    const u = await h.signUp('ana')
    const r = await h.json('POST', '/v1/market/orders', { token: u.token, body: { symbol: 'XAU', side: 'buy', amountMinor: 1000 } })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatchObject({ code: 'forbidden', message: 'Verify your identity to trade metals.' })
  })

  it('first purchase of a metal: authorize (reserve sponsored), then the deposit; the metal arrives on received', async () => {
    const { h, metals, ids, issuer } = setup()
    const ana = await verifiedUser(h, 'ana')
    const before = await balanceOf(h, ana)

    const first = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'buy', amountMinor: 1000 } })
    expect(first.status).toBe(200)
    expect(MarketOrderResponse.safeParse(first.body).success).toBe(true)
    expect(first.body.intent).toBeUndefined()
    expect(first.body.prepared.kind).toBe('market_authorize')
    expect(first.body.prepared.tx).toMatchObject({ TransactionType: 'MPTokenAuthorize', Account: ana.user.address, MPTokenIssuanceID: ids.XAU })
    expect(first.body.quote).toEqual({ quantityMg: 87, amountMinor: 995, unitPriceMinor: 11435, spreadMinor: 6 })
    expect((await h.submit(ana, first.body.prepared)).body.status).toBe('validated')

    const second = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'buy', amountMinor: 1000 } })
    expect(second.status).toBe(200)
    expect(second.body.prepared.kind).toBe('send')
    expect(second.body.prepared.tx).toMatchObject({ TransactionType: 'ConfidentialMPTSend', Destination: h.keystore.getWallet('pool').address })
    expect(second.body.intent).toMatchObject({ kind: 'market_buy', status: 'created', amountMinor: 995, feeMinor: 6, fromUserId: ana.user.id })
    const s = await h.submit(ana, second.body.prepared)
    expect(s.body.status).toBe('validated')
    await h.settle()

    const intent = (await h.json('GET', `/v1/transfers/${second.body.intent.id}`, { token: ana.token })).body
    expect(intent.status).toBe('paid_out')
    expect(intent.payoutTxHash).toMatch(/^[0-9A-F]{64}$/)
    expect(metals.payments).toEqual([{ from: issuer, to: ana.user.address, iss: ids.XAU, mg: 87 }])
    expect(await balanceOf(h, ana)).toBe(before - 995)
    expect(h.pool.payouts.filter((p) => p.intentId === second.body.intent.id)).toHaveLength(0) // the dollars stay in the pool

    const hold = await h.json('GET', '/v1/market/holdings', { token: ana.token })
    expect(HoldingsResponse.safeParse(hold.body).success).toBe(true)
    expect(hold.body.find((x: { symbol: string }) => x.symbol === 'XAU')).toEqual({ symbol: 'XAU', quantityMg: 87, valueMinor: 984 })
    const act = (await h.json('GET', '/v1/activity', { token: ana.token })).body.items
    expect(act[0]).toMatchObject({ kind: 'market_buy', direction: 'out', amountMinor: 995, note: '0.087 g of gold', status: 'done' })
    expect(act[0].ledger.payoutTxHash).toBe(intent.payoutTxHash)

    // second purchase of the same metal: no authorize step
    const again = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'buy', quantityMg: 1000 } })
    expect(again.body.prepared.kind).toBe('send')
    expect(again.body.quote).toEqual({ quantityMg: 1000, amountMinor: 11435, unitPriceMinor: 11435, spreadMinor: 57 })
  })

  it('delivers the metal once per intent, however often received is reported', async () => {
    const { h, metals } = setup()
    const ana = await verifiedUser(h, 'ana')
    const o = await buy(h, ana, { symbol: 'XAG', amountMinor: 500 })
    const i = h.pool.expected.find((e) => e.intentId === o.intent.id)!
    h.pool.emit({ type: 'received', ...i })
    await h.app.core.receivedHandlers.get('market_buy')!(h.app.core, o.intent.id)
    await h.settle()
    expect(metals.payments).toHaveLength(1)
  })

  it('retries a delivery the ledger refused, then gives up with a sentence the user can read', async () => {
    const { h, metals } = setup()
    const ana = await verifiedUser(h, 'ana')
    metals.failNextDeliveries(1)
    const o = await buy(h, ana, { symbol: 'XPD', amountMinor: 500 })
    await eventually(async () => expect((await h.json('GET', `/v1/transfers/${o.intent.id}`, { token: ana.token })).body.status).toBe('paid_out'))
    expect(metals.payments).toHaveLength(1)

    metals.failNextDeliveries(10)
    const o2 = await buy(h, ana, { symbol: 'XPD', amountMinor: 500 })
    await eventually(async () => {
      const i = (await h.json('GET', `/v1/transfers/${o2.intent.id}`, { token: ana.token })).body
      expect(i.status).toBe('failed')
      expect(i.failure.message).toMatch(/couldn't deliver/)
    })
    expect(metals.payments).toHaveLength(1)
  })

  it('a delivery whose answer is lost but which landed is looked up, never sent again', async () => {
    const { h, metals, ids } = setup()
    const ana = await verifiedUser(h, 'ana')
    metals.loseNextDelivery({ applied: true })
    const o = await buy(h, ana, { symbol: 'XAU', amountMinor: 1000 })
    const status = async () => (await h.json('GET', `/v1/transfers/${o.intent.id}`, { token: ana.token })).body
    expect((await status()).status).toBe('received') // not known yet: neither sent again nor failed
    expect(metals.payments).toHaveLength(1)
    await marketTick(h.app.core)
    await h.settle()
    const landed = h.ledger.applied.find((e) => (e.tx.Amount as { mpt_issuance_id?: string })?.mpt_issuance_id === ids.XAU)!
    expect(await status()).toMatchObject({ status: 'paid_out', payoutTxHash: landed.hash })
    expect(metals.payments).toEqual([expect.objectContaining({ mg: 87 })])
    await marketTick(h.app.core)
    expect(metals.payments).toHaveLength(1)
  })

  it('a delivery that threw after it was sent is found by its invoice id', async () => {
    const { h, metals } = setup()
    const ana = await verifiedUser(h, 'ana')
    metals.loseNextDelivery({ applied: true, throws: true })
    const o = await buy(h, ana, { symbol: 'XAG', amountMinor: 500 })
    await marketTick(h.app.core)
    await h.settle()
    expect((await h.json('GET', `/v1/transfers/${o.intent.id}`, { token: ana.token })).body.status).toBe('paid_out')
    expect(metals.payments).toHaveLength(1)
  })

  it('a delivery whose answer is lost and which never landed is sent again only once its LastLedgerSequence has passed', async () => {
    const { h, metals } = setup()
    const ana = await verifiedUser(h, 'ana')
    metals.loseNextDelivery({ applied: false })
    const o = await buy(h, ana, { symbol: 'XPD', amountMinor: 500 })
    const status = async () => (await h.json('GET', `/v1/transfers/${o.intent.id}`, { token: ana.token })).body.status
    await marketTick(h.app.core)
    await h.settle()
    expect(await status()).toBe('received') // it may still validate
    expect(metals.payments).toHaveLength(0)
    h.ledger.advance(25)
    await marketTick(h.app.core)
    await h.settle()
    expect(await status()).toBe('paid_out')
    expect(metals.payments).toHaveLength(1)
  })

  it('a sale whose payout is not confirmed stays received and is asked again until it lands (never failed)', async () => {
    const { h } = setup()
    const ana = await verifiedUser(h, 'ana')
    await buy(h, ana, { symbol: 'XAU', amountMinor: 1000 }) // 87 mg
    const before = await balanceOf(h, ana)
    const payout = h.pool.payout.bind(h.pool)
    let unknown = 2
    let calls = 0
    h.pool.payout = async (i) => {
      calls++
      if (unknown-- > 0) throw Object.assign(new Error('payout not confirmed'), { code: 'payout_unknown' })
      return payout(i)
    }
    const o = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'sell', quantityMg: 50 } })
    expect((await h.submit(ana, o.body.prepared)).body.status).toBe('validated')
    await h.settle()
    const intent = async () => (await h.json('GET', `/v1/transfers/${o.body.intent.id}`, { token: ana.token })).body
    expect(await intent()).toMatchObject({ status: 'received' })
    expect((await intent()).failure).toBeUndefined()
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.pendingMinor).toBe(566)
    for (let k = 0; k < 4; k++) {
      h.clock.advance(60_000)
      await marketTick(h.app.core)
      await h.settle()
    }
    expect(calls).toBe(3)
    expect((await intent()).status).toBe('paid_out')
    expect(await balanceOf(h, ana)).toBe(before + 566)
  })

  it("a sale whose inbox merge keeps failing is settled by a later tick (the money doesn't stay pending)", async () => {
    const { h } = setup()
    const ana = await verifiedUser(h, 'ana')
    await buy(h, ana, { symbol: 'XAU', amountMinor: 1000 })
    const before = await balanceOf(h, ana)
    const merge = h.pool.mergeInboxFor.bind(h.pool)
    let refuse = 5
    h.pool.mergeInboxFor = async (a) => {
      if (refuse-- > 0) throw new Error('merge refused')
      return merge(a)
    }
    const o = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'sell', quantityMg: 50 } })
    expect((await h.submit(ana, o.body.prepared)).body.status).toBe('validated')
    await h.settle()
    expect((await h.json('GET', `/v1/transfers/${o.body.intent.id}`, { token: ana.token })).body.status).toBe('paid_out')
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body).toMatchObject({ availableMinor: before, pendingMinor: 566 })
    for (let k = 0; k < 6; k++) {
      h.clock.advance(60_000)
      await marketTick(h.app.core)
      await h.settle()
    }
    expect(refuse).toBeLessThan(0)
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body).toMatchObject({ availableMinor: before + 566, pendingMinor: 0 })
    expect(h.pool.payouts.filter((p) => p.intentId === o.body.intent.id)).toHaveLength(1)
  })

  it('refuses a purchase above the balance before anything is signed, and one too small to buy a milligram', async () => {
    const { h } = setup()
    const ana = await verifiedUser(h, 'ana', 0)
    const big = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'buy', amountMinor: 100_000 } })
    expect(big.status).toBe(409)
    expect(big.body.error.code).toBe('insufficient_funds')
    const tiny = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'buy', amountMinor: 5 } })
    expect(tiny.status).toBe(400)
    expect(tiny.body.error.message).toMatch(/smallest amount/)
  })

  it('sell: the user pays the metal back (sponsored), then the pool pays out the dollars like a payout', async () => {
    const { h, metals, ids, issuer } = setup()
    const ana = await verifiedUser(h, 'ana')
    await buy(h, ana, { symbol: 'XAU', amountMinor: 1000 }) // 87 mg
    const before = await balanceOf(h, ana)

    const too = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'sell', quantityMg: 88 } })
    expect(too.status).toBe(409)
    expect(too.body.error.message).toBe('You have 0.087 g of gold.')

    const o = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'sell', quantityMg: 50 } })
    expect(o.status).toBe(200)
    expect(MarketOrderResponse.safeParse(o.body).success).toBe(true)
    expect(o.body.quote).toEqual({ quantityMg: 50, amountMinor: 566, unitPriceMinor: 11321, spreadMinor: 2 })
    expect(o.body.prepared.kind).toBe('market_sell')
    expect(o.body.prepared.tx).toMatchObject({
      TransactionType: 'Payment',
      Account: ana.user.address,
      Destination: issuer,
      Amount: { mpt_issuance_id: ids.XAU, value: '50' },
      Sponsor: h.keystore.getWallet('sponsor').address,
    })
    expect(o.body.intent).toMatchObject({ kind: 'market_buy', status: 'created', toUserId: ana.user.id, amountMinor: 568, feeMinor: 2 })
    const s = await h.submit(ana, o.body.prepared)
    expect(s.body.status).toBe('validated')
    await h.settle()

    const intent = (await h.json('GET', `/v1/transfers/${o.body.intent.id}`, { token: ana.token })).body
    expect(intent).toMatchObject({ status: 'paid_out', depositTxHash: s.body.hash })
    expect(h.pool.payouts.filter((p) => p.intentId === o.body.intent.id)).toEqual([{ intentId: o.body.intent.id, to: ana.user.address, amountMinor: 566 }])
    const b = (await h.json('GET', '/v1/balance', { token: ana.token })).body
    expect(b.availableMinor + b.pendingMinor, JSON.stringify(b)).toBe(before + 566)
    await eventually(async () => expect(await balanceOf(h, ana)).toBe(before + 566))
    expect(metals.payments.at(-1)).toEqual({ from: ana.user.address, to: issuer, iss: ids.XAU, mg: 50 })
    const hold = (await h.json('GET', '/v1/market/holdings', { token: ana.token })).body
    expect(hold.find((x: { symbol: string }) => x.symbol === 'XAU').quantityMg).toBe(37)
    const act = (await h.json('GET', '/v1/activity', { token: ana.token })).body.items
    expect(act[0]).toMatchObject({ kind: 'market_buy', direction: 'in', amountMinor: 566, feeMinor: 2, note: 'Sold 0.05 g of gold' })

    // the same approval cannot be used twice
    const again = await h.json('POST', '/v1/tx/submit', { token: ana.token, body: { prepareId: o.body.prepared.prepareId, txBlob: await h.sign(ana.signer, o.body.prepared) } })
    expect(again.status).toBe(403)
    expect(h.pool.payouts.filter((p) => p.intentId === o.body.intent.id)).toHaveLength(1)
  })

  it('a sale the ledger refuses pays nothing and keeps the metal', async () => {
    const { h, metals } = setup()
    const ana = await verifiedUser(h, 'ana')
    await buy(h, ana, { symbol: 'XAU', amountMinor: 1000 })
    const before = await balanceOf(h, ana)
    const o = await h.json('POST', '/v1/market/orders', { token: ana.token, body: { symbol: 'XAU', side: 'sell', amountMinor: 100 } })
    h.ledger.failNext('tecINSUFFICIENT_FUNDS')
    const s = await h.submit(ana, o.body.prepared)
    expect(s.body.status).toBe('failed')
    await h.settle()
    expect((await h.json('GET', `/v1/transfers/${o.body.intent.id}`, { token: ana.token })).body.status).toBe('failed')
    expect(h.pool.payouts.filter((p) => p.intentId === o.body.intent.id)).toHaveLength(0)
    expect(await balanceOf(h, ana)).toBe(before)
    expect(metals.payments).toHaveLength(1)
  })

  it('DEMO_MODE test hook lifts the tier (and does not exist outside demo mode)', async () => {
    const { h } = setup()
    const u = await h.signUp('ana')
    const r = await h.json('POST', '/v1/dev/market/tier', { token: u.token })
    expect(r.status).toBe(200)
    expect(r.body.tier).toBe(1)
    expect((await h.json('POST', '/v1/dev/market/tier', {})).status).toBe(401)
    const prod = setup({ env: { DEMO_MODE: '0' } })
    const v = await prod.h.signUp('bea')
    expect((await prod.h.json('POST', '/v1/dev/market/tier', { token: v.token })).status).toBe(404)
  })
})
