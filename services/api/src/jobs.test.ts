import { describe, expect, it } from 'vitest'
import type { IntentKind } from '@zecca/contracts'
import { makeHarness } from './testing/harness'
import { intents } from './intents/repo'
import { storePrepared } from './prepared/store'
import { expireIntents } from './jobs'

// expireIntents: a deposit the person never approved stops being "created" once its approval can no longer reach the ledger.
describe('expireIntents', () => {
  async function unapproved(kind: IntentKind) {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    const core = h.app.core
    const id = core.id('int')
    intents.insert(core, { id, kind, status: 'created', fromUserId: ana.user.id, amountMinor: 500, feeMinor: 0 })
    const tx = await core.ledger.buildSend({
      from: ana.user.address,
      to: core.keystore.getWallet('pool').address,
      amountMinor: 500,
      senderKey: core.keystore.getElGamal({ user: ana.user.address }),
      sponsored: true,
      publicKey: ana.signer.publicKey,
    })
    const p = await storePrepared(core, { address: ana.user.address, publicKey: ana.signer.publicKey, kind: 'send', tx, intentId: id })
    h.clock.advance(Date.parse(p.expiresAt) - h.clock.now + 1000)
    return { h, id }
  }

  for (const kind of ['p2p', 'merchant', 'card_load', 'earn_deposit', 'market_buy'] as const) {
    it(`expires an unapproved ${kind} deposit once its approval has run out`, async () => {
      const { h, id } = await unapproved(kind)
      expect(await expireIntents(h.app.core)).toBe(1)
      expect(intents.byId(h.app.core, id)?.status).toBe('expired')
    })
  }

  it('leaves a created top-up alone (the mint recovery owns it)', async () => {
    const { h, id } = await unapproved('topup')
    expect(await expireIntents(h.app.core)).toBe(0)
    expect(intents.byId(h.app.core, id)?.status).toBe('created')
  })
})
