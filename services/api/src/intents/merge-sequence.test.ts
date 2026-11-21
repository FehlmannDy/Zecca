// A relayer merge runs as the user (Account = the user, Delegate = the relayer), so it takes the user's next Sequence. It must
// never land between a prepare (Sequence and proof fixed) and its submit (BUILD §8 rule 7). Real mock ledger, real pool worker.
import { describe, expect, it } from 'vitest'
import { createMockEnvironment, type MockLedger } from '@zecca/ledger-mock'
import { createMemoryPoolStore, createPoolWorker } from '@zecca/pool-worker'
import type { PoolWorker } from '@zecca/contracts'
import { eventually, makeHarness, type TestUser } from '../testing/harness'
import { UNUSED_HOLD_MS } from '../prepared/account-gate'

function realWorld(validationDelayMs = 0) {
  const env = createMockEnvironment({ validationDelayMs })
  const pool = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, pollMs: 1e9, lagMonitor: false })
  const h = makeHarness<MockLedger, PoolWorker>({ ledger: env.ledger, keystore: env.keystore, pool })
  const onLedger = (u: TestUser) => env.ledger.mock.balances(u.user.address)
  const balance = async (u: TestUser) => (await h.json('GET', '/v1/balance', { token: u.token })).body
  const credit = async (u: TestUser, amountMinor: number) => expect((await h.json('POST', '/v1/dev/credit', { token: u.token, body: { amountMinor } })).status).toBe(200)
  const prepareSend = async (from: TestUser, to: TestUser, amountMinor: number) => {
    const t = await h.json('POST', '/v1/transfers', { token: from.token, body: { to: to.user.id, amountMinor } })
    expect(t.status).toBe(200)
    return t.body.prepared
  }
  return { h, env, pool, onLedger, balance, credit, prepareSend }
}

describe('relayer merges and the user’s own transactions', () => {
  it('money that arrives while a send waits for approval is merged after it, and the send goes through', { timeout: 15_000 }, async () => {
    const w = realWorld()
    await w.pool.start()
    const ana = await w.h.signUp('ana')
    const carla = await w.h.signUp('carla')
    const prepared = await w.prepareSend(ana, carla, 1200)
    await w.credit(ana, 4000)
    await w.h.settle()
    expect(w.onLedger(ana)).toMatchObject({ spendableMinor: 5000, inboxMinor: 4000 }) // paid out, not merged: the approval is open
    expect(await w.balance(ana)).toMatchObject({ availableMinor: 5000, pendingMinor: 4000 })

    const s = await w.h.submit(ana, prepared)
    expect(s.body).toMatchObject({ status: 'validated', engineResult: 'tesSUCCESS' })
    await eventually(async () => expect(await w.balance(ana)).toMatchObject({ availableMinor: 7800, pendingMinor: 0 }), 5000)
    expect(w.onLedger(ana)).toMatchObject({ spendableMinor: 7800, inboxMinor: 0 })
    await w.pool.stop()
  })

  it('a send prepared while a merge is in flight waits for it, so its sequence is fresh', { timeout: 15_000 }, async () => {
    const w = realWorld(40)
    let started!: () => void
    const mergeStarted = new Promise<void>((r) => (started = r))
    const submitAs = w.env.ledger.submitAs.bind(w.env.ledger)
    w.env.ledger.submitAs = (role, tx) => {
      if (role === 'relayer') started()
      return submitAs(role, tx)
    }
    await w.pool.start()
    const ana = await w.h.signUp('ana')
    const carla = await w.h.signUp('carla')
    await w.credit(ana, 4000)
    await mergeStarted // the relayer's merge of Ana's inbox is on its way to the ledger
    const prepared = await w.prepareSend(ana, carla, 1200)
    const s = await w.h.submit(ana, prepared)
    expect(s.body).toMatchObject({ status: 'validated', engineResult: 'tesSUCCESS' })
    await w.h.settle()
    await eventually(async () => expect(await w.balance(ana)).toMatchObject({ availableMinor: 7800, pendingMinor: 0 }), 5000)
    expect(w.onLedger(ana)).toMatchObject({ spendableMinor: 7800, inboxMinor: 0 })
    await w.pool.stop()
  })

  it('a postponed merge runs once the approval fails on the ledger', { timeout: 15_000 }, async () => {
    const w = realWorld()
    await w.pool.start()
    const ana = await w.h.signUp('ana')
    const carla = await w.h.signUp('carla')
    const prepared = await w.prepareSend(ana, carla, 1200)
    await w.credit(ana, 4000)
    await w.h.settle()
    w.env.ledger.mock.failNext('tecINSUFFICIENT_FUNDS')
    expect((await w.h.submit(ana, prepared)).body.status).toBe('failed')
    await eventually(async () => expect(await w.balance(ana)).toMatchObject({ availableMinor: 9000, pendingMinor: 0 }), 5000)
    expect(w.onLedger(ana)).toMatchObject({ spendableMinor: 9000, inboxMinor: 0 })
    await w.pool.stop()
  })

  it('an approval left unused holds the merge back for two minutes at most', { timeout: 15_000 }, async () => {
    const w = realWorld()
    await w.pool.start()
    const ana = await w.h.signUp('ana')
    const carla = await w.h.signUp('carla')
    await w.prepareSend(ana, carla, 1200) // the approve sheet is closed without approving
    await w.credit(ana, 4000)
    await w.h.settle()
    w.h.clock.advance(60_000)
    await w.h.app.jobs.tick()
    await w.h.settle()
    expect(w.onLedger(ana).inboxMinor).toBe(4000) // still held
    w.h.clock.advance(UNUSED_HOLD_MS)
    await w.h.app.jobs.tick()
    await w.h.settle()
    await eventually(async () => expect(await w.balance(ana)).toMatchObject({ availableMinor: 9000, pendingMinor: 0 }), 5000)
    expect(w.onLedger(ana)).toMatchObject({ spendableMinor: 9000, inboxMinor: 0 })
    await w.pool.stop()
  })

  it('a postponed merge runs on the jobs tick once the approval can no longer reach the ledger', { timeout: 15_000 }, async () => {
    const w = realWorld()
    await w.pool.start()
    const ana = await w.h.signUp('ana')
    const carla = await w.h.signUp('carla')
    await w.prepareSend(ana, carla, 1200)
    await w.credit(ana, 4000)
    await w.h.settle()
    expect(w.onLedger(ana).inboxMinor).toBe(4000)
    w.env.ledger.mock.advance(200) // past LastLedgerSequence, still inside the time window
    w.h.clock.advance(5_000) // the retry backoff
    await w.h.app.jobs.tick()
    await w.h.settle()
    await eventually(async () => expect(await w.balance(ana)).toMatchObject({ availableMinor: 9000, pendingMinor: 0 }), 5000)
    expect(w.onLedger(ana)).toMatchObject({ spendableMinor: 9000, inboxMinor: 0 })
    await w.pool.stop()
  })
})
