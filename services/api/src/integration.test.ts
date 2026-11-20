// The API with the real mock ledger (@zecca/ledger-mock) and the real pool worker (@zecca/pool-worker), in process:
// two users sign up with the mock signer, a p2p send, a merchant request paid; balances and activity on both sides.
import { describe, expect, it } from 'vitest'
import { createMockEnvironment, type MockLedger } from '@zecca/ledger-mock'
import { createMemoryPoolStore, createPoolWorker } from '@zecca/pool-worker'
import type { PoolWorker } from '@zecca/contracts'
import { eventually, makeHarness } from './testing/harness'
import { seedDemoShop } from './seed'

function realWorld() {
  const env = createMockEnvironment()
  const pool = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, pollMs: 1e9, lagMonitor: false })
  const h = makeHarness<MockLedger, PoolWorker>({ ledger: env.ledger, keystore: env.keystore, pool })
  return { h, env, pool }
}

describe('integration: mock ledger + pool worker', () => {
  it('sign-up, p2p send, merchant request paid; books match the ledger on both sides', async () => {
    const { h, env, pool } = realWorld()
    await pool.start()
    const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
    const carla = await h.signUp('carla', { displayName: 'Carla Rossi' })
    const bruno = await h.signUp('caffebruno', { role: 'merchant', businessName: 'Caffè Bruno', displayName: 'Bruno Esposito' })
    expect(env.ledger.mock.balances(ana.user.address)).toMatchObject({ spendableMinor: 5000, inboxMinor: 0 })
    const bal = async (t: string) => (await h.json('GET', '/v1/balance', { token: t })).body

    // p2p: Ana -> Carla $12.00
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1200, note: 'Dinner' } })
    expect(t.status).toBe(200)
    const s = await h.submit(ana, t.body.prepared)
    expect(s.body).toMatchObject({ status: 'validated', engineResult: 'tesSUCCESS' })
    await eventually(async () => expect(await bal(carla.token)).toMatchObject({ availableMinor: 6200, pendingMinor: 0 }), 5000)
    expect(await bal(ana.token)).toMatchObject({ availableMinor: 3800, pendingMinor: 0 })
    expect(env.ledger.mock.balances(carla.user.address)).toMatchObject({ spendableMinor: 6200, inboxMinor: 0 })
    expect(env.ledger.mock.balances(ana.user.address)).toMatchObject({ spendableMinor: 3800, inboxMinor: 0 })

    // merchant: Bruno charges $4.50, Ana pays
    const pr = (await h.json('POST', '/v1/payment-requests', { token: bruno.token, body: { amountMinor: 450, reference: 'Table 4' } })).body
    expect((await h.json('GET', `/v1/payment-requests/${pr.id}`)).body.status).toBe('opened')
    const pay = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    expect(pay.status).toBe(200)
    expect((await h.submit(ana, pay.body.prepared)).body.status).toBe('validated')
    await eventually(async () => expect((await h.json('GET', `/v1/payment-requests/${pr.id}`)).body.status).toBe('paid'), 5000)
    await eventually(async () => expect(await bal(bruno.token)).toMatchObject({ availableMinor: 5448, pendingMinor: 0 }), 5000)
    expect(env.ledger.mock.balances(bruno.user.address)).toMatchObject({ spendableMinor: 5448, inboxMinor: 0 })
    expect(env.ledger.mock.balances(h.keystore.getWallet('pool').address).spendableMinor).toBe(2) // the fee stays in the pool

    const sales = (await h.json('GET', '/v1/merchant/sales', { token: bruno.token })).body
    expect(sales.totals).toEqual({ grossMinor: 450, feeMinor: 2, netMinor: 448, count: 1 })
    await eventually(async () => expect((await h.json('GET', '/v1/merchant/sales', { token: bruno.token })).body.items[0].payoutStatus).toBe('done'))

    // Activity: both sides, with the two ledger hashes and the ciphertext preview.
    const anaItems = (await h.json('GET', '/v1/activity', { token: ana.token })).body.items
    expect(anaItems.map((a: { kind: string; direction: string }) => `${a.kind}:${a.direction}`)).toEqual(['merchant:out', 'p2p:out', 'welcome:in'])
    const coffee = anaItems[0]
    expect(coffee).toMatchObject({ amountMinor: 450, status: 'done', note: 'Table 4', counterparty: { displayName: 'Caffè Bruno' } })
    expect(coffee.ledger.depositTxHash).toMatch(/^[0-9A-F]{64}$/)
    expect(coffee.ledger.payoutTxHash).toMatch(/^[0-9A-F]{64}$/)
    expect(coffee.ledger.depositTxHash).not.toBe(coffee.ledger.payoutTxHash)
    expect(coffee.ledger.ciphertextPreview).toMatch(/^[0-9A-F]{16}$/)
    const carlaItems = (await h.json('GET', '/v1/activity', { token: carla.token })).body.items
    expect(carlaItems[0]).toMatchObject({ kind: 'p2p', direction: 'in', amountMinor: 1200, counterparty: { handle: 'ana' }, status: 'done' })
    const brunoItems = (await h.json('GET', '/v1/activity', { token: bruno.token })).body.items
    expect(brunoItems[0]).toMatchObject({ kind: 'merchant', direction: 'in', amountMinor: 448, feeMinor: 2 })

    // The background reconciliation finds nothing to report.
    expect(await h.app.jobs.reconcile()).toEqual([])
    await pool.stop()
  })

  it('dev credit through the real pool: mint, payout, merge', async () => {
    const { h, env, pool } = realWorld()
    await pool.start()
    const ana = await h.signUp('ana')
    const r = await h.json('POST', '/v1/dev/credit', { token: ana.token, body: { amountMinor: 4000 } })
    expect(r.status).toBe(200)
    await eventually(async () => expect((await h.json('GET', '/v1/balance', { token: ana.token })).body).toMatchObject({ availableMinor: 9000, pendingMinor: 0 }), 5000)
    expect(env.ledger.mock.balances(ana.user.address)).toMatchObject({ spendableMinor: 9000, inboxMinor: 0 })
    await pool.stop()
  })

  it('seeds the demo shop merchant from the key store, once, and it can be paid', async () => {
    const { h, pool } = realWorld()
    await pool.start()
    const id = await seedDemoShop(h.app.core)
    expect(await seedDemoShop(h.app.core)).toBe(id)
    const ana = await h.signUp('ana')
    const shop = (await h.json('GET', '/v1/directory/resolve?q=settearchi', { token: ana.token })).body
    expect(shop).toEqual({ kind: 'zecca', profile: { id, handle: 'settearchi', displayName: 'Sette Archi', isMerchant: true } })
    expect(h.app.core.db.prepare('SELECT address FROM users WHERE id = ?').get(id)).toEqual({ address: h.keystore.getWallet('demoShop').address })
    await pool.stop()
  })
})
