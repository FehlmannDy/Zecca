import { describe, expect, it } from 'vitest'
import { ActivityPage, Balance, Intent, IntentWithPrepared } from '@zecca/contracts'
import { createFakePool } from '../testing/fakes'
import { eventually, makeHarness } from '../testing/harness'

async function two(o: Parameters<typeof makeHarness>[0] = {}) {
  const h = makeHarness(o)
  const ana = await h.signUp('ana')
  const carla = await h.signUp('carla')
  return { h, ana, carla }
}
const bal = async (h: ReturnType<typeof makeHarness>, token: string) => Balance.parse((await h.json('GET', '/v1/balance', { token })).body)

describe('p2p transfer through the pool', () => {
  it('created -> submitted -> received -> paid_out; balances and activity on both sides', async () => {
    const { h, ana, carla } = await two()
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1200, note: 'Dinner' } })
    expect(t.status).toBe(200)
    const { intent, prepared } = IntentWithPrepared.parse(t.body)
    expect(intent).toMatchObject({ kind: 'p2p', status: 'created', feeMinor: 0, amountMinor: 1200, note: 'Dinner', toUserId: carla.user.id })
    expect(prepared.kind).toBe('send')
    expect(prepared.tx.Destination).toBe(h.keystore.getWallet('pool').address)
    expect(prepared.tx.SigningPubKey).toBe(ana.signer.publicKey)

    const s = await h.submit(ana, prepared)
    expect(s.body.status).toBe('validated')
    expect(Intent.parse(s.body.intent).status).toBe('submitted')
    expect(s.body.intent.depositTxHash).toBe(s.body.hash)
    expect(h.pool.expected[0]).toEqual({ intentId: intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 1200 })
    expect((await bal(h, ana.token)).availableMinor).toBe(3800)

    await eventually(async () => expect((await h.json('GET', `/v1/transfers/${intent.id}`, { token: ana.token })).body.status).toBe('paid_out'))
    await h.app.core.idle()
    expect(h.pool.payouts[0]).toEqual({ intentId: intent.id, to: carla.user.address, amountMinor: 1200 })
    expect(h.pool.merges).toContain(carla.user.address)
    expect(await bal(h, carla.token)).toMatchObject({ availableMinor: 6200, pendingMinor: 0 })

    const anaAct = ActivityPage.parse((await h.json('GET', '/v1/activity', { token: ana.token })).body)
    expect(anaAct.items[0]).toMatchObject({ direction: 'out', kind: 'p2p', amountMinor: 1200, status: 'done', note: 'Dinner', counterparty: { handle: 'carla' } })
    expect(anaAct.items[0].ledger.depositTxHash).toBe(s.body.hash)
    expect(anaAct.items[0].ledger.payoutTxHash).toMatch(/^[0-9A-F]{64}$/)
    expect(anaAct.items[0].ledger.ciphertextPreview).toBe(String(prepared.tx.DestinationEncryptedAmount).slice(0, 16))
    const carlaAct = ActivityPage.parse((await h.json('GET', '/v1/activity', { token: carla.token })).body)
    expect(carlaAct.items[0]).toMatchObject({ direction: 'in', kind: 'p2p', amountMinor: 1200, counterparty: { handle: 'ana' } })

    // Contacts both ways.
    expect((await h.json('GET', '/v1/contacts', { token: ana.token })).body.map((p: { handle: string }) => p.handle)).toEqual(['carla'])
    expect((await h.json('GET', '/v1/contacts', { token: carla.token })).body.map((p: { handle: string }) => p.handle)).toEqual(['ana'])
  })

  it('the recipient sees the money as pending between received and the merge', async () => {
    const pool = createFakePool({ auto: false })
    const { h, ana, carla } = await two({ pool })
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 500 } })
    const s = await h.submit(ana, t.body.prepared)
    pool.emit({ type: 'received', intentId: t.body.intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 500 })
    await eventually(async () => expect(await bal(h, carla.token)).toMatchObject({ availableMinor: 5000, pendingMinor: 500 }))
    await h.app.core.idle()
    // The payout promise resolved: paid out, merged, available.
    expect(await bal(h, carla.token)).toMatchObject({ availableMinor: 5500, pendingMinor: 0 })
  })

  it('received is idempotent (a duplicate event credits once, pays out once)', async () => {
    const pool = createFakePool({ auto: false })
    const { h, ana, carla } = await two({ pool })
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 700 } })
    const s = await h.submit(ana, t.body.prepared)
    const e = { type: 'received' as const, intentId: t.body.intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 700 }
    pool.emit(e)
    pool.emit(e)
    await h.app.core.idle()
    pool.emit(e)
    await h.app.core.idle()
    expect(pool.payouts).toHaveLength(1)
    expect(await bal(h, carla.token)).toMatchObject({ availableMinor: 5700, pendingMinor: 0 })
    expect((await h.json('GET', '/v1/activity', { token: carla.token })).body.items.filter((a: { kind: string }) => a.kind === 'p2p')).toHaveLength(1)
  })

  it('a deposit whose amount does not match the intent fails and credits nothing', async () => {
    const pool = createFakePool({ auto: false })
    const { h, ana, carla } = await two({ pool })
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 700 } })
    const s = await h.submit(ana, t.body.prepared)
    pool.emit({ type: 'received', intentId: t.body.intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 70_000 })
    await h.app.core.idle()
    const i = (await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: ana.token })).body
    expect(i.status).toBe('failed')
    expect(i.failure.code).toBe('amount_mismatch')
    expect(await bal(h, carla.token)).toMatchObject({ availableMinor: 5000, pendingMinor: 0 })
    expect(pool.payouts).toHaveLength(0)
  })

  it('a received event for another hash is ignored', async () => {
    const pool = createFakePool({ auto: false })
    const { h, ana, carla } = await two({ pool })
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 700 } })
    await h.submit(ana, t.body.prepared)
    pool.emit({ type: 'received', intentId: t.body.intent.id, txHash: 'F'.repeat(64), from: ana.user.address, amountMinor: 700 })
    await h.app.core.idle()
    expect((await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: ana.token })).body.status).toBe('submitted')
  })

  it('a payout error fails the intent, removes the pending credit, keeps the money in the pool', async () => {
    const pool = createFakePool({ auto: false })
    pool.failPayouts = true
    const { h, ana, carla } = await two({ pool })
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 300 } })
    const s = await h.submit(ana, t.body.prepared)
    pool.emit({ type: 'received', intentId: t.body.intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 300 })
    await h.app.core.idle()
    const i = (await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: carla.token })).body
    expect(i.status).toBe('failed')
    expect(i.failure.code).toBe('payout_failed')
    expect(await bal(h, carla.token)).toMatchObject({ availableMinor: 5000, pendingMinor: 0 })
  })

  it('refuses unknown recipients, yourself, and more than the balance (insufficient_funds with shortMinor)', async () => {
    const { h, ana, carla } = await two()
    expect((await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: 'usr_nobody', amountMinor: 100 } })).status).toBe(404)
    expect((await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: ana.user.id, amountMinor: 100 } })).status).toBe(400)
    const r = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 5120 } })
    expect(r.status).toBe(409)
    expect(r.body.error).toEqual({ code: 'insufficient_funds', message: 'You need $1.20 more.', details: { shortMinor: 120 } })
    expect((await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 0 } })).status).toBe(400)
    expect((await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1.5 } })).status).toBe(400)
  })

  it('two intents cannot overspend: the second submit is refused when the first took the funds', async () => {
    const { h, ana, carla } = await two()
    const a = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 3000 } })
    const b = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 3000 } })
    expect((await h.submit(ana, a.body.prepared)).body.status).toBe('validated')
    const r = await h.submit(ana, b.body.prepared)
    expect(r.status).toBe(409)
    expect(r.body.error.code).toBe('insufficient_funds')
  })

  it('GET /v1/transfers/:id is visible to both sides only', async () => {
    const { h, ana, carla } = await two()
    const bob = await h.signUp('bob')
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 100 } })
    expect((await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: carla.token })).status).toBe(200)
    expect((await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: bob.token })).status).toBe(404)
  })

  it('activity pages with a cursor, newest first', async () => {
    const { h, ana, carla } = await two()
    for (const amount of [100, 200, 300]) {
      const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: amount } })
      await h.submit(ana, t.body.prepared)
    }
    const p1 = await h.json('GET', '/v1/activity?limit=2', { token: ana.token })
    expect(p1.body.items.map((a: { amountMinor: number }) => a.amountMinor)).toEqual([300, 200])
    expect(p1.body.nextCursor).toBeDefined()
    const p2 = await h.json('GET', `/v1/activity?limit=2&cursor=${p1.body.nextCursor}`, { token: ana.token })
    expect(p2.body.items.map((a: { amountMinor: number }) => a.amountMinor)).toEqual([100, 5000])
    expect(p2.body.nextCursor).toBeUndefined()
    expect((await h.json('GET', '/v1/activity?cursor=abc', { token: ana.token })).status).toBe(400)
  })
})

describe('expiry job', () => {
  it('expires created intents whose LastLedgerSequence passed, but not ones being submitted', async () => {
    const { h, ana, carla } = await two()
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 100 } })
    await h.app.jobs.tick()
    expect((await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: ana.token })).body.status).toBe('created')
    h.ledger.advance(200)
    await h.app.jobs.tick()
    expect((await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: ana.token })).body.status).toBe('expired')
  })
})

describe('reconciliation', () => {
  it('reports users whose decrypted ledger balance differs from our books', async () => {
    const { h, ana, carla } = await two()
    h.ledger.setConfidential(ana.user.address, { spendableMinor: 5000, inboxMinor: 0 })
    h.ledger.setConfidential(carla.user.address, { spendableMinor: 4000, inboxMinor: 500 })
    const diffs = await h.app.jobs.reconcile()
    expect(diffs).toEqual([{ userId: carla.user.id, handle: 'carla', booksMinor: 5000, ledgerMinor: 4500 }])
  })
})
