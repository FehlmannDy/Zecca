import { describe, expect, it } from 'vitest'
import { Intent } from '@zecca/contracts'
import { makeHarness } from './testing/harness'

describe('POST /v1/dev/credit', () => {
  it('goes through SPEC §2.7: mint into the pool, payout to the user, merge; activity "topup" with "Demo credit"', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    const r = await h.json('POST', '/v1/dev/credit', { token: ana.token, body: { amountMinor: 4000 } })
    expect(r.status).toBe(200)
    expect(Intent.parse(r.body)).toMatchObject({ amountMinor: 4000, feeMinor: 0, toUserId: ana.user.id, fromUserId: 'zecca' })
    await h.settle()
    expect(h.pool.mints).toEqual([{ amountMinor: 4000, reference: `dev-credit:${r.body.id}` }])
    expect(h.pool.payouts).toEqual([{ intentId: r.body.id, to: ana.user.address, amountMinor: 4000 }])
    expect(h.pool.merges).toEqual([ana.user.address])
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body).toMatchObject({ availableMinor: 9000, pendingMinor: 0 })
    const act = (await h.json('GET', '/v1/activity', { token: ana.token })).body.items[0]
    expect(act).toMatchObject({ kind: 'topup', direction: 'in', amountMinor: 4000, note: 'Demo credit', status: 'done' })
    expect(act.ledger.depositTxHash).toMatch(/^[0-9A-F]{64}$/)
    expect(act.ledger.payoutTxHash).toMatch(/^[0-9A-F]{64}$/)
    expect(act.counterparty).toBeUndefined()
  })

  it('a failed mint fails the intent and credits nothing', async () => {
    const h = makeHarness()
    h.pool.mintIn = async () => {
      throw new Error('issuer down')
    }
    const ana = await h.signUp('ana')
    const r = await h.json('POST', '/v1/dev/credit', { token: ana.token, body: { amountMinor: 1000 } })
    await h.settle()
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(5000)
    expect(h.app.core.bus.history().some((x) => x.event.type === 'intent.updated' && x.event.data.id === r.body.id && x.event.data.status === 'failed')).toBe(true)
  })

  it('is 404 without DEMO_MODE=1', async () => {
    const h = makeHarness({ env: { DEMO_MODE: '0' } })
    const ana = await h.signUp('ana')
    const r = await h.json('POST', '/v1/dev/credit', { token: ana.token, body: { amountMinor: 1000 } })
    expect(r.status).toBe(404)
  })
})
