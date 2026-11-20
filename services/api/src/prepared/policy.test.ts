// The sponsor policy (D11, SPEC §4.3): the sponsor co-signs only the exact transaction we prepared, once, for its owner.
import { describe, expect, it } from 'vitest'
import { decode, encode } from 'ripple-binary-codec'
import { mockRawSigner } from '@zecca/xrpl-core/signer'
import { makeHarness, type TestUser } from '../testing/harness'

async function setup() {
  const h = makeHarness()
  const ana = await h.signUp('ana')
  const carla = await h.signUp('carla')
  const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1200 } })
  expect(t.status).toBe(200)
  return { h, ana, carla, prepared: t.body.prepared }
}

/** Signs a modified copy of the prepared tx with the user's own key (a valid signature over the wrong transaction). */
async function signTampered(u: TestUser, tx: Record<string, unknown>, change: (tx: Record<string, unknown>) => void) {
  const copy = structuredClone(tx)
  change(copy)
  return (await u.signer.sign(copy)).tx_blob
}

const submitBlob = (h: ReturnType<typeof makeHarness>, u: TestUser, prepareId: string, txBlob: string) =>
  h.json('POST', '/v1/tx/submit', { token: u.token, body: { prepareId, txBlob } })

describe('sponsor policy', () => {
  it('accepts the exact prepared transaction, signed by its owner, once', async () => {
    const { h, ana, prepared } = await setup()
    const ok = await h.submit(ana, prepared)
    expect(ok.status).toBe(200)
    expect(ok.body.status).toBe('validated')
    expect(h.ledger.submitted.filter((s) => s.tx.TransactionType === 'ConfidentialMPTSend')).toHaveLength(1)
  })

  for (const [name, change] of [
    ['amount (ciphertext)', (tx: Record<string, unknown>) => (tx.DestinationEncryptedAmount = '03' + 'F'.repeat(130))],
    ['destination', (tx: Record<string, unknown>) => (tx.Destination = mockRawSigner().address)],
    ['fee', (tx: Record<string, unknown>) => (tx.Fee = '999999')],
    ['sequence', (tx: Record<string, unknown>) => (tx.Sequence = Number(tx.Sequence) + 1)],
    ['last ledger sequence', (tx: Record<string, unknown>) => (tx.LastLedgerSequence = Number(tx.LastLedgerSequence) + 1000)],
    ['unsponsored (Sponsor removed)', (tx: Record<string, unknown>) => (delete tx.Sponsor, delete tx.SponsorFlags)],
    ['sponsor flags (reserve added)', (tx: Record<string, unknown>) => (tx.SponsorFlags = 3)],
  ] as const) {
    it(`refuses a tampered ${name} with 403 policy_refused, and submits nothing`, async () => {
      const { h, ana, prepared } = await setup()
      const before = h.ledger.submitted.length
      const blob = await signTampered(ana, prepared.tx, change)
      const r = await submitBlob(h, ana, prepared.prepareId, blob)
      expect(r.status).toBe(403)
      expect(r.body.error.code).toBe('policy_refused')
      expect(r.body.error.message).toMatch(/[A-Z].*\.$/)
      expect(h.ledger.submitted.length).toBe(before)
      // The genuine one still goes through afterwards (nothing was marked used).
      expect((await h.submit(ana, prepared)).body.status).toBe('validated')
    })
  }

  it('refuses a field added outside the signature (BatchSigners on the onboarding Batch)', async () => {
    const h = makeHarness()
    const { token, signer } = await h.signIn()
    const p = await h.json('POST', '/v1/onboarding/prepare', {
      token,
      body: { address: signer.address, publicKey: signer.publicKey, handle: 'ana', displayName: 'Ana', role: 'user' },
    })
    const good = await h.sign(signer, p.body)
    const tx = decode(good) as Record<string, any>
    tx.BatchSigners = [{ BatchSigner: { Account: mockRawSigner().address, SigningPubKey: '02' + '2'.repeat(64), TxnSignature: 'CD'.repeat(70) } }]
    const r = await h.json('POST', '/v1/tx/submit', { token, body: { prepareId: p.body.prepareId, txBlob: encode(tx as never) } })
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('policy_refused')
  })

  it("refuses another user's prepareId", async () => {
    const { h, carla, prepared } = await setup()
    // Carla signs Ana's transaction body with her own key: wrong account, wrong prepare owner.
    const r = await submitBlob(h, carla, prepared.prepareId, await signTampered(carla, prepared.tx, () => {}))
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('policy_refused')
  })

  it("refuses Ana's own blob submitted from Carla's session", async () => {
    const { h, ana, carla, prepared } = await setup()
    const blob = await h.sign(ana.signer, prepared)
    const r = await submitBlob(h, carla, prepared.prepareId, blob)
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('policy_refused')
  })

  it('refuses a replay of an accepted blob', async () => {
    const { h, ana, prepared } = await setup()
    const blob = await h.sign(ana.signer, prepared)
    expect((await submitBlob(h, ana, prepared.prepareId, blob)).body.status).toBe('validated')
    const again = await submitBlob(h, ana, prepared.prepareId, blob)
    expect(again.status).toBe(403)
    expect(again.body.error.code).toBe('policy_refused')
    expect(h.ledger.submitted.filter((s) => s.tx.TransactionType === 'ConfidentialMPTSend')).toHaveLength(1)
  })

  it('refuses two concurrent submits of the same approval: exactly one reaches the ledger', async () => {
    const { h, ana, prepared } = await setup()
    const blob = await h.sign(ana.signer, prepared)
    const [a, b] = await Promise.all([submitBlob(h, ana, prepared.prepareId, blob), submitBlob(h, ana, prepared.prepareId, blob)])
    expect([a.status, b.status].sort()).toEqual([200, 403])
    expect(h.ledger.submitted.filter((s) => s.tx.TransactionType === 'ConfidentialMPTSend')).toHaveLength(1)
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(5000 - 1200)
  })

  it('refuses an expired approval (time) and one whose LastLedgerSequence passed', async () => {
    const { h, ana, carla, prepared } = await setup()
    h.clock.advance(60 * 60_000)
    const r1 = await h.submit(ana, prepared)
    expect(r1.status).toBe(403)
    expect(r1.body.error.message).toMatch(/expired/)

    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 100 } })
    h.ledger.advance(151)
    const r2 = await h.submit(ana, t.body.prepared)
    expect(r2.status).toBe(403)
    expect(r2.body.error.code).toBe('policy_refused')
  })

  it('refuses a signature that does not verify (403 signature_invalid)', async () => {
    const { h, ana, prepared } = await setup()
    const other = mockRawSigner()
    const foreign = decode((await other.sign(prepared.tx)).tx_blob) as Record<string, unknown>
    const tx = decode(await h.sign(ana.signer, prepared)) as Record<string, unknown>
    tx.TxnSignature = foreign.TxnSignature
    const r = await submitBlob(h, ana, prepared.prepareId, encode(tx as never))
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('signature_invalid')
  })

  it('refuses a blob with no signature, and an unreadable blob', async () => {
    const { h, ana, prepared } = await setup()
    const tx = decode(await h.sign(ana.signer, prepared)) as Record<string, unknown>
    delete tx.TxnSignature
    const r = await submitBlob(h, ana, prepared.prepareId, encode(tx as never))
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('signature_invalid')
    const bad = await submitBlob(h, ana, prepared.prepareId, 'DEADBEEF')
    expect(bad.status).toBe(400)
  })

  it('refuses a SigningPubKey other than the session key, even with a valid signature by that key', async () => {
    const { h, ana, prepared } = await setup()
    const other = mockRawSigner()
    const blob = (await other.sign({ ...prepared.tx })).tx_blob
    const r = await submitBlob(h, ana, prepared.prepareId, blob)
    expect(r.status).toBe(403)
  })

  it('a ledger failure refunds the reservation and marks the intent failed', async () => {
    const { h, ana, prepared } = await setup()
    h.ledger.failNext('tecINSUFFICIENT_FUNDS')
    const r = await h.submit(ana, prepared)
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('failed')
    expect(r.body.intent.status).toBe('failed')
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(5000)
    // And it cannot be retried with the same approval.
    expect((await h.submit(ana, prepared)).status).toBe(403)
  })

  it('a network error on submit answers 502 ledger_error and keeps the reservation until the ledger says (unknown.test.ts)', async () => {
    const { h, ana, prepared } = await setup()
    h.ledger.throwNext('socket hang up')
    const r = await h.submit(ana, prepared)
    expect(r.status).toBe(502)
    expect(r.body.error.code).toBe('ledger_error')
    expect((await h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(3800)
  })
})
