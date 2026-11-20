import { describe, expect, it } from 'vitest'
import type { FakeLedger, FakePool } from '../testing/fakes'
import { makeHarness } from '../testing/harness'

// Found at integration gate 1 on Devnet: proof generation in buildSend takes 1-3 s; the expiry job ran meanwhile,
// saw an intent with no prepared tx yet ([].every(...) === true) and expired it before the user could approve.
describe('expiry job vs a payment still being prepared', () => {
  it('does not expire an intent whose prepared transaction is still being built', async () => {
    const h = makeHarness<FakeLedger, FakePool>()
    const ana = await h.signUp('ana')
    const carla = await h.signUp('carla')
    const realBuild = h.ledger.buildSend.bind(h.ledger)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    h.ledger.buildSend = async (p) => {
      await gate
      return realBuild(p)
    }
    const pending = h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 100 } })
    await new Promise((r) => setTimeout(r, 20))
    await h.app.jobs.tick()
    release()
    const t = await pending
    expect(t.status).toBe(200)
    expect((await h.json('GET', `/v1/transfers/${t.body.intent.id}`, { token: ana.token })).body.status).toBe('created')
    const s = await h.submit(ana, t.body.prepared)
    expect(s.body.status).toBe('validated')
  })
})
