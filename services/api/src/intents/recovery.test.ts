// Work that fails or is lost to a restart is picked up again: merges, payouts, top-ups being minted.
import { describe, expect, it } from 'vitest'
import { createApp } from '../app'
import { getBalance } from '../books'
import { silentLogger } from '../core'
import { createFakePool } from '../testing/fakes'
import { TEST_ENV, eventually, makeHarness, type TestUser } from '../testing/harness'
import { intents } from './repo'

async function world() {
  const h = makeHarness()
  const ana = await h.signUp('ana')
  const carla = await h.signUp('carla')
  const send = async (to: TestUser, amountMinor: number) => {
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: to.user.id, amountMinor } })
    expect((await h.submit(ana, t.body.prepared)).body.status).toBe('validated')
    return t.body.intent.id as string
  }
  return { h, ana, carla, send }
}
const hang = () => new Promise<never>(() => {})

describe('merges that fail', () => {
  it('the next successful merge for the same recipient settles the earlier payouts too', { timeout: 15_000 }, async () => {
    const { h, carla, send } = await world()
    let down = true
    const merge = h.pool.mergeInboxFor.bind(h.pool)
    h.pool.mergeInboxFor = async (a) => {
      if (down) throw new Error('relayer down')
      return merge(a)
    }
    await send(carla, 500)
    await h.settle()
    expect(getBalance(h.app.core, carla.user.id)).toMatchObject({ availableMinor: 5000, pendingMinor: 500 })
    down = false
    await send(carla, 700)
    await h.settle()
    expect(getBalance(h.app.core, carla.user.id)).toMatchObject({ availableMinor: 6200, pendingMinor: 0 })
  })

  it('the jobs tick tries a failed merge again, after a backoff', { timeout: 15_000 }, async () => {
    const { h, carla, send } = await world()
    let down = true
    const merge = h.pool.mergeInboxFor.bind(h.pool)
    h.pool.mergeInboxFor = async (a) => {
      if (down) throw new Error('relayer down')
      return merge(a)
    }
    const id = await send(carla, 500)
    await h.settle()
    down = false
    await h.app.jobs.tick()
    await h.settle()
    expect(getBalance(h.app.core, carla.user.id).pendingMinor).toBe(500) // too soon
    h.clock.advance(5_000)
    await h.app.jobs.tick()
    await h.settle()
    expect(getBalance(h.app.core, carla.user.id)).toMatchObject({ availableMinor: 5500, pendingMinor: 0 })
    expect(intents.byId(h.app.core, id)!.status).toBe('paid_out')
  })
})

describe('payouts the pool worker could not confirm', () => {
  it('payout_unknown leaves the intent received (money pending) and the jobs tick asks again', async () => {
    const { h, carla, send } = await world()
    const payout = h.pool.payout.bind(h.pool)
    let unknown = true
    h.pool.payout = async (i) => {
      if (unknown) {
        h.pool.emit({ type: 'failed', intentId: i.intentId, stage: 'payout', code: 'payout_unknown', message: 'SUBMIT_ERROR; not found yet' })
        throw Object.assign(new Error('not found yet'), { code: 'payout_unknown' })
      }
      return payout(i)
    }
    const id = await send(carla, 400)
    await h.settle()
    expect(intents.byId(h.app.core, id)!.status).toBe('received')
    expect(getBalance(h.app.core, carla.user.id)).toMatchObject({ availableMinor: 5000, pendingMinor: 400 })
    unknown = false
    h.clock.advance(5_000)
    await h.app.jobs.tick()
    await h.settle()
    expect(intents.byId(h.app.core, id)!.status).toBe('paid_out')
    expect(getBalance(h.app.core, carla.user.id)).toMatchObject({ availableMinor: 5400, pendingMinor: 0 })
  })
})

describe('after a restart', () => {
  it('a received intent is paid out, a paid-out one is settled, a top-up being minted is minted again with its reference', async () => {
    const { h, carla, send } = await world()
    const bruno = await h.signUp('bruno')
    const payout = h.pool.payout.bind(h.pool)
    const merge = h.pool.mergeInboxFor.bind(h.pool)
    h.pool.payout = async (i) => (i.to === carla.user.address ? hang() : payout(i))
    h.pool.mergeInboxFor = async (a) => (a === bruno.user.address ? hang() : merge(a))
    h.pool.mintIn = async () => hang()

    const toCarla = await send(carla, 300)
    const toBruno = await send(bruno, 200)
    const topup = (await h.json('POST', '/v1/dev/credit', { token: carla.token, body: { amountMinor: 1000 } })).body.id as string
    const status = (id: string) => intents.byId(h.app.core, id)!.status
    await eventually(() => expect([status(toCarla), status(toBruno), status(topup)]).toEqual(['received', 'paid_out', 'created']))

    // The process stops here. A new one opens the same database with a fresh pool worker client.
    const pool = createFakePool()
    const app = createApp({ env: TEST_ENV, db: h.app.core.db, ledger: h.ledger, keystore: h.keystore, poolWorker: pool, clock: () => h.clock.now, log: silentLogger })
    await app.jobs.tick()
    for (let k = 0; k < 4; k++) {
      await new Promise((r) => setTimeout(r, 5))
      await app.core.idle()
    }

    expect(pool.payouts).toContainEqual({ intentId: toCarla, to: carla.user.address, amountMinor: 300 })
    expect(pool.mints).toEqual([{ amountMinor: 1000, reference: `dev-credit:${topup}` }])
    expect([status(toCarla), status(toBruno), status(topup)]).toEqual(['paid_out', 'paid_out', 'paid_out'])
    expect(getBalance(app.core, carla.user.id)).toMatchObject({ availableMinor: 6300, pendingMinor: 0 })
    expect(getBalance(app.core, bruno.user.id)).toMatchObject({ availableMinor: 5200, pendingMinor: 0 })
  })
})
