import { describe, expect, it } from 'vitest'
import type { FakeLedger, FakePool } from '../testing/fakes'
import { eventually, makeHarness } from '../testing/harness'

// Extension point for phase-2 connectors (card_load, market_buy, earn_deposit): a connector registers what happens
// on 'received' for its own intent kind; the default p2p/merchant effects (recipient credit + payout) do not run.
describe('received handlers per intent kind', () => {
  it('runs the registered handler once, instead of the p2p payout', async () => {
    const h = makeHarness<FakeLedger, FakePool>()
    const ana = await h.signUp('ana')
    const carla = await h.signUp('carla')
    const calls: string[] = []
    h.app.core.receivedHandlers.set('card_load', async (_core, intentId) => {
      calls.push(intentId)
    })
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 700 } })
    h.app.core.db.prepare("UPDATE intents SET kind = 'card_load', to_user_id = NULL WHERE id = ?").run(t.body.intent.id)
    const s = await h.submit(ana, t.body.prepared)
    expect(s.body.status).toBe('validated')
    await eventually(() => expect(calls).toEqual([t.body.intent.id]))
    await h.app.core.idle()
    expect((await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: ana.token })).body.status).toBe('received')
    expect(h.pool.payouts ?? []).toHaveLength(0)
  })
})
