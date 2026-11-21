// A refund's money goes back on the ledger: card settlement account -> pool, once per Lithic return (returns.ts).
// The real mock ledger and pool worker, the fake Lithic calling our ASA webhook, the poller driven by hand (cardSync).
import { describe, expect, it } from 'vitest'
import type { Ledger, SubmitResult } from '@zecca/contracts'
import { createMockEnvironment } from '@zecca/ledger-mock'
import { createMemoryPoolStore, createPoolWorker } from '@zecca/pool-worker'
import { eventually, makeHarness, type TestUser } from '../../testing/harness'
import { users } from '../../users'
import { createFakeLithic, type FakeLithic } from './fake-lithic'
import { signHeaders } from './lithic-sig'
import { cardBalanceOf, cardSync, mountCard, registerCard, stopCard } from './index'
import { LOOKUP_LIMIT, MAX_RETURN_TRIES } from './returns'
import { cardCtx } from './context'

async function world(o: { settlementKey?: boolean } = {}) {
  const env = createMockEnvironment()
  const settlement = env.keystore.getWallet('cardSettlement').address
  if (o.settlementKey !== false) env.keystore.createUserElGamal(settlement)
  const pool = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, pollMs: 1e9, lagMonitor: false })
  const logs: string[] = []
  const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }
  const h = makeHarness({ env: { FEATURE_CARD: '1' }, ledger: env.ledger as never, keystore: env.keystore, pool: pool as never, extra: { log } })
  const lithic = createFakeLithic()
  mountCard(h.app, h.app.core, { lithic, simulateGapMs: 0, pollMs: 0 })
  registerCard(h.app.core)
  lithic.asa = async (body) => {
    const raw = JSON.stringify(body)
    const headers = signHeaders(raw, lithic.secret, { ts: Math.floor(h.clock.now / 1000) })
    const res = await h.call('POST', '/v1/webhooks/lithic/asa', { body: raw, headers: { 'content-type': 'application/json', ...headers } })
    return ((await res.json()) as { result: string }).result
  }
  await pool.start()
  const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
  users.setTier(h.app.core, ana.user.id, 1)
  expect((await h.json('POST', '/v1/card', { token: ana.token })).status).toBe(200)
  const poolAddress = env.keystore.getWallet('pool').address
  const funds = (address: string) => {
    const b = env.ledger.mock.balances(address)
    return b.spendableMinor + b.inboxMinor
  }
  /** ConfidentialMPTSends on the ledger from one account to another. */
  const sends = (from: string, to: string) => env.ledger.mock.txs().filter((e) => e.tx.TransactionType === 'ConfidentialMPTSend' && e.tx.Account === from && e.tx.Destination === to)
  const done = async () => {
    await h.app.core.idle()
    stopCard(h.app.core)
    await pool.stop()
  }
  return { env, h, lithic, ana, pool, settlement, poolAddress, funds, sends, logs, done }
}
type W = Awaited<ReturnType<typeof world>>

async function load(w: W, ana: TestUser, amountMinor: number) {
  const before = cardBalanceOf(w.h.app.core, ana.user.id) ?? 0
  const l = await w.h.json('POST', '/v1/card/load', { token: ana.token, body: { amountMinor } })
  expect((await w.h.submit(ana, l.body.prepared)).body.status).toBe('validated')
  await eventually(() => expect(cardBalanceOf(w.h.app.core, ana.user.id)).toBe(before + amountMinor), 5000)
}
const panOf = async (w: W) => (await w.h.json('GET', '/v1/card/secret', { token: w.ana.token })).body.pan as string
/** A return at Lithic (the shop refunds the card), then one poller pass and its background work. */
async function shopRefunds(w: W, amountMinor: number, lithic: FakeLithic = w.lithic) {
  const { token } = await lithic.simulateReturn({ amount: amountMinor, descriptor: 'SETTE ARCHI', pan: await panOf(w) })
  await pass(w)
  return `${token}:return`
}
async function pass(w: W) {
  await cardSync(w.h.app.core)
  await w.h.app.core.idle()
}
const row = (w: W, key: string) => cardCtx(w.h.app.core).store.returnOf(key)
const hold = (w: W, key: string) => cardCtx(w.h.app.core).store.hold(key)

/** The next cardSettlement send loses its answer (SUBMIT_ERROR); `applied`: it reached the ledger all the same. */
function loseNextSend(ledger: Ledger, o: { applied: boolean }) {
  const real = ledger.submitAs.bind(ledger)
  ledger.submitAs = async (role, tx): Promise<SubmitResult> => {
    if (role !== 'cardSettlement' || tx.TransactionType !== 'ConfidentialMPTSend') return real(role, tx)
    ledger.submitAs = real
    const r = o.applied ? await real(role, tx) : undefined
    return { validated: false, engineResult: 'SUBMIT_ERROR', hash: r?.hash ?? '0'.repeat(64) }
  }
}

describe('a refund on the ledger: card settlement account -> pool', () => {
  it('moves the refunded amount back to the pool once, merging the settlement inbox first', async () => {
    const w = await world()
    await load(w, w.ana, 2000)
    const r = await w.h.json('POST', '/v1/dev/card/simulate', { token: w.ana.token, body: { amountMinor: 1200, merchantName: 'Sette Archi' } })
    expect(r.body.approved).toBe(true)
    await eventually(() => expect(w.env.ledger.mock.balances(w.settlement)).toMatchObject({ spendableMinor: 0, inboxMinor: 1200 }), 5000)
    const poolBefore = w.funds(w.poolAddress)

    const key = await shopRefunds(w, 500)
    expect(cardBalanceOf(w.h.app.core, w.ana.user.id)).toBe(800 + 500)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(w.env.ledger.mock.balances(w.settlement)).toMatchObject({ spendableMinor: 700, inboxMinor: 0 })
    expect(w.funds(w.poolAddress)).toBe(poolBefore + 500)
    expect(row(w, key)).toMatchObject({ status: 'sent', txHash: w.sends(w.settlement, w.poolAddress)[0].hash })
    expect(hold(w, key)?.settleError).toBeUndefined()
    expect(w.logs.some((m) => m.includes(`[card] return ${key}: 500 back card settlement -> pool`))).toBe(true)

    await pass(w)
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(w.funds(w.poolAddress)).toBe(poolBefore + 500)
    await w.done()
  })

  it('nothing on the settlement account yet: the failure stays on the refund line and the poller sends it later, once', async () => {
    const w = await world()
    await load(w, w.ana, 1000)
    const poolBefore = w.funds(w.poolAddress)
    const key = await shopRefunds(w, 250)
    expect(cardBalanceOf(w.h.app.core, w.ana.user.id)).toBe(1250)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(0)
    expect(row(w, key)).toMatchObject({ status: 'pending', tries: 1 })
    expect(hold(w, key)?.settleError).toMatch(/card settlement account holds 0, the refund needs 250/)

    w.env.ledger.mock.credit(w.settlement, 1000)
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(w.funds(w.poolAddress)).toBe(poolBefore + 250)
    expect(row(w, key)?.status).toBe('sent')
    expect(hold(w, key)?.settleError).toBeUndefined()
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    await w.done()
  })

  it('a refused send is tried again on the next pass', async () => {
    const w = await world()
    w.env.ledger.mock.credit(w.settlement, 1000)
    w.env.ledger.mock.failNext('tecNO_PERMISSION')
    const key = await shopRefunds(w, 300)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(0)
    expect(row(w, key)).toMatchObject({ status: 'pending', error: expect.stringMatching(/tecNO_PERMISSION/) })
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(row(w, key)?.status).toBe('sent')
    await w.done()
  })

  it('an answer lost after the send landed: the next pass finds it on the ledger and never sends twice', async () => {
    const w = await world()
    w.env.ledger.mock.credit(w.settlement, 1000)
    const poolBefore = w.funds(w.poolAddress)
    loseNextSend(w.env.ledger, { applied: true })
    const key = await shopRefunds(w, 300)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(row(w, key)).toMatchObject({ status: 'reserved', error: expect.stringMatching(/SUBMIT_ERROR/) })
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(row(w, key)).toMatchObject({ status: 'sent', txHash: w.sends(w.settlement, w.poolAddress)[0].hash })
    expect(w.funds(w.poolAddress)).toBe(poolBefore + 300)
    await w.done()
  })

  it('an answer lost before the send reached the ledger: waits while it could still validate, then sends once', async () => {
    const w = await world()
    w.env.ledger.mock.credit(w.settlement, 1000)
    loseNextSend(w.env.ledger, { applied: false })
    const key = await shopRefunds(w, 300)
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(0)
    expect(row(w, key)?.status).toBe('reserved')
    w.env.ledger.mock.advance(30)
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(row(w, key)?.status).toBe('sent')
    await w.done()
  })

  it('a landed send whose answer was lost, pushed out of the lookup by incoming payments: stopped for a person, never sent twice', async () => {
    const w = await world()
    w.env.ledger.mock.credit(w.settlement, 1000)
    w.env.ledger.mock.credit(w.poolAddress, LOOKUP_LIMIT)
    loseNextSend(w.env.ledger, { applied: true })
    const key = await shopRefunds(w, 300)
    expect(row(w, key)?.status).toBe('reserved')
    // As many payments into the settlement account as the lookup reads (pool settlements, or anyone paying its public address).
    const poolKey = w.env.keystore.getElGamal('pool')
    for (let i = 0; i < LOOKUP_LIMIT; i++) {
      const r = await w.env.ledger.submitAs('pool', await w.env.ledger.buildSend({ from: w.poolAddress, to: w.settlement, amountMinor: 1, senderKey: poolKey, sponsored: false }))
      expect(r.engineResult).toBe('tesSUCCESS')
    }
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(row(w, key)).toMatchObject({ status: 'stopped', error: expect.stringMatching(/check the card settlement account by hand/) })
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    await w.done()
  })

  it('the reserved sequence went to another transaction of the account: the return is sent fresh, once', async () => {
    const w = await world()
    w.env.ledger.mock.credit(w.settlement, 1000)
    loseNextSend(w.env.ledger, { applied: false })
    const key = await shopRefunds(w, 300)
    const reserved = row(w, key)?.sequence
    expect(row(w, key)?.status).toBe('reserved')
    // Something else signed by the account takes that sequence (here: merging its inbox).
    const m = await w.env.ledger.submitAs('cardSettlement', await w.env.ledger.buildMergeInbox({ account: w.settlement, sponsored: false }))
    expect(m.engineResult).toBe('tesSUCCESS')
    const merge = w.env.ledger.mock.txs().find((e) => e.hash === m.hash)
    expect(Number(merge?.tx.Sequence)).toBe(reserved)
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    expect(row(w, key)).toMatchObject({ status: 'sent', txHash: w.sends(w.settlement, w.poolAddress)[0].hash })
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(1)
    await w.done()
  })

  it(`stops after ${MAX_RETURN_TRIES} tries and says so`, async () => {
    const w = await world()
    const key = await shopRefunds(w, 250)
    for (let i = 1; i < MAX_RETURN_TRIES + 3; i++) await pass(w)
    expect(row(w, key)).toMatchObject({ status: 'stopped', tries: MAX_RETURN_TRIES })
    expect(row(w, key)?.error).toMatch(/not tried again/)
    w.env.ledger.mock.credit(w.settlement, 1000)
    await pass(w)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(0)
    await w.done()
  })

  it("the settlement account's encryption key is missing from the key store: said on the refund line, nothing sent", async () => {
    const w = await world({ settlementKey: false })
    w.env.ledger.mock.credit(w.settlement, 1000)
    const key = await shopRefunds(w, 250)
    expect(cardBalanceOf(w.h.app.core, w.ana.user.id)).toBe(250)
    expect(w.sends(w.settlement, w.poolAddress)).toHaveLength(0)
    expect(hold(w, key)?.settleError).toMatch(/no encryption key for the card settlement account/)
    await w.done()
  })

  it('a void before the clearing moves nothing on the ledger (the purchase never settled)', async () => {
    const w = await world()
    await load(w, w.ana, 1000)
    const txsBefore = w.env.ledger.mock.txs().length
    const { token } = await w.lithic.simulateAuthorize({ amount: 400, descriptor: 'CAFFE BRUNO', pan: await panOf(w) })
    await w.lithic.simulateVoid({ token })
    await pass(w)
    expect(hold(w, token)?.status).toBe('voided')
    expect(cardBalanceOf(w.h.app.core, w.ana.user.id)).toBe(1000)
    expect(w.env.ledger.mock.txs().length).toBe(txsBefore)
    await w.done()
  })
})

describe('clearing for more than authorised (a tip)', () => {
  it('covered by the card: the extra is taken and the whole cleared amount settles', async () => {
    const w = await world()
    await load(w, w.ana, 2000)
    const { token } = await w.lithic.simulateAuthorize({ amount: 1000, descriptor: 'CAFFE BRUNO', pan: await panOf(w) })
    await w.lithic.simulateClearing({ token, amount: 1150 })
    await pass(w)
    expect(cardBalanceOf(w.h.app.core, w.ana.user.id)).toBe(850)
    expect(hold(w, token)).toMatchObject({ status: 'completed', amountMinor: 1150 })
    await eventually(() => expect(w.funds(w.settlement)).toBe(1150), 5000)
    await w.done()
  })

  it('not covered: the purchase keeps its authorised amount, settles that, and the gap is logged', async () => {
    const w = await world()
    await load(w, w.ana, 1000)
    const { token } = await w.lithic.simulateAuthorize({ amount: 1000, descriptor: 'CAFFE BRUNO', pan: await panOf(w) })
    await w.lithic.simulateClearing({ token, amount: 1150 })
    await pass(w)
    expect(cardBalanceOf(w.h.app.core, w.ana.user.id)).toBe(0)
    expect(hold(w, token)).toMatchObject({ status: 'completed', amountMinor: 1000 })
    await eventually(() => expect(w.funds(w.settlement)).toBe(1000), 5000)
    expect(w.logs.some((m) => m.includes(`[card] ${token}: cleared 1150, authorised 1000`) && m.includes('not covered'))).toBe(true)
    await w.done()
  })
})
