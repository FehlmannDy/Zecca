// A submit whose answer was lost (no reply, SUBMIT_ERROR, a throw): the outcome is unknown, not failed. The reservation stays
// until the ledger shows the transaction, or its LastLedgerSequence passes without it.
import { describe, expect, it } from 'vitest'
import { getBalance } from '../books'
import { intents } from '../intents/repo'
import { makeHarness } from '../testing/harness'
import { users } from '../users'

const UNCONFIRMED = "The payment network hasn't confirmed this yet. It will update here by itself within a few minutes."

async function setup() {
  const h = makeHarness()
  const ana = await h.signUp('ana')
  const carla = await h.signUp('carla')
  const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1200 } })
  expect(t.status).toBe(200)
  const id = t.body.intent.id as string
  const intent = () => intents.byId(h.app.core, id)!
  const bal = (u: typeof ana) => getBalance(h.app.core, u.user.id)
  return { h, ana, carla, id, intent, bal, prepared: t.body.prepared }
}
const tick = async (h: ReturnType<typeof makeHarness>) => {
  await h.app.jobs.tick()
  await h.settle()
}

describe('a submit whose answer was lost', () => {
  it('SUBMIT_ERROR after the deposit landed: 502, nothing refunded, then the jobs tick carries the payment through', async () => {
    const { h, ana, carla, id, intent, bal, prepared } = await setup()
    h.ledger.loseNext({ applied: true })
    const r = await h.submit(ana, prepared)
    expect(r.status).toBe(502)
    expect(r.body.error).toEqual({ code: 'ledger_error', message: UNCONFIRMED })
    expect(intent().status).toBe('created')
    expect(bal(ana).availableMinor).toBe(3800)
    expect((await h.submit(ana, prepared)).status).toBe(403) // the approval is used

    await tick(h)
    expect(intent().status).toBe('paid_out')
    expect(intent().depositTxHash).toBe(h.ledger.applied.at(-1)!.hash)
    expect(h.pool.expected).toContainEqual({ intentId: id, txHash: intent().depositTxHash, from: ana.user.address, amountMinor: 1200 })
    expect(bal(ana)).toMatchObject({ availableMinor: 3800, pendingMinor: 0 })
    expect(bal(carla)).toMatchObject({ availableMinor: 6200, pendingMinor: 0 })
    const act = (await h.json('GET', '/v1/activity', { token: ana.token })).body.items[0]
    expect(act).toMatchObject({ intentId: id, direction: 'out', amountMinor: 1200 })
  })

  it('SUBMIT_ERROR, never applied: stays reserved while it could still land, refunded once LastLedgerSequence has passed', async () => {
    const { h, ana, intent, bal, prepared } = await setup()
    h.ledger.loseNext({ applied: false })
    expect((await h.submit(ana, prepared)).status).toBe(502)
    await tick(h)
    expect(intent().status).toBe('created')
    expect(bal(ana).availableMinor).toBe(3800)

    h.ledger.advance(151)
    await tick(h)
    expect(intent().status).toBe('failed')
    expect(intent().failure?.message).toBe("The payment didn't go through. Nothing was taken from your balance.")
    expect(bal(ana).availableMinor).toBe(5000)
  })

  it('a submit that threw after the deposit landed is found by account and sequence', async () => {
    const { h, ana, intent, bal, prepared } = await setup()
    h.ledger.loseNext({ applied: true, throws: true })
    const r = await h.submit(ana, prepared)
    expect(r.status).toBe(502)
    expect(r.body.error.message).toBe(UNCONFIRMED)
    await tick(h)
    expect(intent().status).toBe('paid_out')
    expect(intent().depositTxHash).toBe(h.ledger.applied.at(-1)!.hash)
    expect(bal(ana).availableMinor).toBe(3800)
  })

  it('a submit that threw and never landed is refunded after LastLedgerSequence, even if another transaction took its sequence', async () => {
    const { h, ana, intent, bal, prepared } = await setup()
    h.ledger.throwNext('socket hang up')
    expect((await h.submit(ana, prepared)).status).toBe(502)
    // Another transaction of Ana's with the same sequence (not this payment: other content).
    h.ledger.applied.push({
      hash: 'AB'.repeat(32),
      ledgerIndex: h.ledger.index,
      validated: true,
      engineResult: 'tesSUCCESS',
      tx: { ...prepared.tx, DestinationEncryptedAmount: '02' + 'E'.repeat(130) },
    })
    await tick(h)
    expect(intent().status).toBe('created')
    h.ledger.advance(151)
    await tick(h)
    expect(intent().status).toBe('failed')
    expect(bal(ana).availableMinor).toBe(5000)
  })

  it('a validated failure (tec) is final at once: refunded, 200 failed', async () => {
    const { h, ana, intent, bal, prepared } = await setup()
    h.ledger.failNext('tecINSUFFICIENT_FUNDS')
    const r = await h.submit(ana, prepared)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('failed')
    expect(intent().status).toBe('failed')
    expect(bal(ana).availableMinor).toBe(5000)
  })

  it('a sign-up whose answer was lost is activated once the ledger shows the Batch', async () => {
    const h = makeHarness()
    const { token, signer } = await h.signIn()
    const p = await h.json('POST', '/v1/onboarding/prepare', {
      token,
      body: { address: signer.address, publicKey: signer.publicKey, handle: 'ana', displayName: 'Ana', role: 'user' },
    })
    h.ledger.loseNext({ applied: true })
    expect((await h.submit({ token, signer }, p.body)).status).toBe(502)
    expect(users.byAddress(h.app.core, signer.address)!.status).toBe('pending')
    await tick(h)
    expect(users.byAddress(h.app.core, signer.address)!.status).toBe('active')
    expect((await h.json('GET', '/v1/balance', { token })).body.availableMinor).toBe(5000)
  })
})
