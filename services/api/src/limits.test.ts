import { describe, expect, it } from 'vitest'
import { ApiError } from '@zecca/contracts'
import { makeHarness } from './testing/harness'
import { users } from './users'

const TIER0 = "You've reached the limit for unverified accounts. Verify your identity to lift it."

async function world(env: Record<string, string> = {}) {
  const h = makeHarness({ env })
  const ana = await h.signUp('ana')
  const carla = await h.signUp('carla', { displayName: 'Carla Rossi' })
  const send = async (from = ana, to = carla, amountMinor: number) => {
    const t = await h.json('POST', '/v1/transfers', { token: from.token, body: { to: to.user.id, amountMinor } })
    if (t.status !== 200) return t
    const s = await h.submit(from, t.body.prepared)
    await h.settle()
    return s
  }
  return { h, ana, carla, send }
}

describe('limits (SPEC §4.8, UI.md §5.12)', () => {
  it('tier 0: $50 per payment -> 403 limit_reached with details and the unverified copy (E2E-1 step 10)', async () => {
    const { h, ana, carla } = await world({ WELCOME_CREDIT_MINOR: '10000' })
    const r = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 6000 } })
    expect(r.status).toBe(403)
    expect(ApiError.parse(r.body).error).toEqual({ code: 'limit_reached', message: TIER0, details: { limit: 'per_payment', capMinor: 5000, usedMinor: 6000 } })
  })

  it('tier 0: $150 sent per month', async () => {
    const { h, ana, carla, send } = await world({ WELCOME_CREDIT_MINOR: '15000', TIER0_BALANCE_CAP_MINOR: '100000' })
    for (let k = 0; k < 3; k++) expect((await send(ana, carla, 5000)).body.status).toBe('validated')
    const r = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1 } })
    expect(r.status).toBe(403)
    expect(r.body.error.details).toEqual({ limit: 'monthly_send', capMinor: 15000, usedMinor: 15000 })
    expect(r.body.error.message).toBe(TIER0)
    // Next month it resets.
    h.clock.advance(31 * 24 * 3_600_000)
    const again = await h.signIn(ana.signer)
    const next = await h.json('POST', '/v1/transfers', { token: again.token, body: { to: carla.user.id, amountMinor: 1 } })
    expect(next.body.error.code).toBe('insufficient_funds') // the cap no longer applies; only the empty balance does
  })

  it('tier 0 recipient: refuses a payment that would take them above $150, telling the sender why', async () => {
    const { h, ana, carla, send } = await world({ WELCOME_CREDIT_MINOR: '5000' })
    const bob = await h.signUp('bob')
    expect((await send(ana, carla, 5000)).body.status).toBe('validated') // carla 10000
    expect((await send(bob, carla, 4000)).body.status).toBe('validated') // carla 14000
    const r = await h.json('POST', '/v1/transfers', { token: bob.token, body: { to: carla.user.id, amountMinor: 1001 } })
    expect(r.status).toBe(403)
    expect(r.body.error.details).toEqual({ limit: 'balance', capMinor: 15000, usedMinor: 14000 })
    expect(r.body.error.message).toBe("Carla Rossi can't receive that much yet. Unverified accounts can hold up to $150.00.")
    expect((await h.json('POST', '/v1/transfers', { token: bob.token, body: { to: carla.user.id, amountMinor: 1000 } })).status).toBe(200)
  })

  it('tier 1: TX_CAP_MINOR per payment, no monthly cap, can receive above $150', async () => {
    const { h, ana, carla, send } = await world({ WELCOME_CREDIT_MINOR: '30000', TX_CAP_MINOR: '20000', TIER0_BALANCE_CAP_MINOR: '100000' })
    users.setTier(h.app.core, ana.user.id, 1)
    users.setTier(h.app.core, carla.user.id, 1)
    const r = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 20001 } })
    expect(r.status).toBe(403)
    expect(r.body.error.details).toEqual({ limit: 'tx_cap', capMinor: 20000, usedMinor: 20001 })
    expect(r.body.error.message).toBe('Payments are limited to $200.00 each.')
    expect((await send(ana, carla, 20000)).body.status).toBe('validated')
  })

  it('DAILY_CAP_MINOR per day for every tier', async () => {
    const { h, ana, carla, send } = await world({ WELCOME_CREDIT_MINOR: '10000', DAILY_CAP_MINOR: '6000', TIER0_BALANCE_CAP_MINOR: '100000' })
    expect((await send(ana, carla, 5000)).body.status).toBe('validated')
    const r = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1001 } })
    expect(r.status).toBe(403)
    expect(r.body.error.details.limit).toBe('daily_cap')
  })

  it('limits are checked again at submit (two approvals prepared together cannot pass the monthly cap)', async () => {
    const { h, ana, carla } = await world({ WELCOME_CREDIT_MINOR: '20000', TIER0_BALANCE_CAP_MINOR: '100000', TIER0_MONTHLY_SEND_CAP_MINOR: '8000' })
    const a = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 5000 } })
    const b = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 5000 } })
    expect((await h.submit(ana, a.body.prepared)).body.status).toBe('validated')
    const r = await h.submit(ana, b.body.prepared)
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('limit_reached')
  })

  it('dev credit respects the tier-0 balance cap', async () => {
    const { h, ana } = await world()
    const r = await h.json('POST', '/v1/dev/credit', { token: ana.token, body: { amountMinor: 10_001 } })
    expect(r.status).toBe(403)
    expect(r.body.error).toEqual({ code: 'limit_reached', message: TIER0, details: { limit: 'balance', capMinor: 15000, usedMinor: 5000 } })
  })
})
