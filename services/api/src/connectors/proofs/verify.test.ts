import { describe, expect, it } from 'vitest'
import * as rk from 'ripple-keypairs'
import { encryptAmount, generateBlindingFactor } from '@xrplf/mpt-crypto'
import type { Statement } from '@zecca/contracts'
import { makeAmountProof } from './amount-proof'
import { signStatement, statementKeyFrom, type UnsignedStatement } from './statement'
import { anchorsFrom, checkStatement, type LedgerReader, type TrustAnchors } from './verify'

const kp = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' }))
const pool = { publicKey: kp.publicKey, privateKey: kp.privateKey.slice(2) }
const POOL = 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ'
const ANA = 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3'
const OTHER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe'
const CMPT = '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9'
const FOREIGN = '00000001A407AF5856CEFBF81F3D4A0A2F7B1E6C4C1A2B3C'
const D = 'D'.repeat(64)
const P = 'E'.repeat(64)
const newKey = () => {
  const seed = rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })
  return statementKeyFrom({ address: rk.deriveAddress(rk.deriveKeypair(seed).publicKey), seed, algorithm: 'ecdsa-secp256k1' })
}
const key = newKey()
const anchors: TrustAnchors = { signer: key.address, pool: POOL, issuanceId: CMPT }
type Tx = { validated: boolean; engineResult: string; tx: Record<string, unknown> }

/** One out line (Ana -> pool -> Carla) and one in line (Bruno -> pool -> Ana), both proven from the pool's side. */
async function fixture(o: { proof?: boolean; amountMinor?: number; deposit?: Record<string, unknown>; payout?: Record<string, unknown>; holder?: string } = {}) {
  const ctOut = await encryptAmount(1200n, pool.publicKey, await generateBlindingFactor())
  const ctIn = await encryptAmount(995n, pool.publicKey, await generateBlindingFactor())
  const send = (tx: Record<string, unknown>): Tx => ({ validated: true, engineResult: 'tesSUCCESS', tx: { TransactionType: 'ConfidentialMPTSend', MPTokenIssuanceID: CMPT, ...tx } })
  const txs: Record<string, Tx> = {
    [D]: send({ Account: ANA, Destination: POOL, DestinationEncryptedAmount: ctOut, ...o.deposit }),
    [P]: send({ Account: POOL, Destination: ANA, SenderEncryptedAmount: ctIn, ...o.payout }),
  }
  const keys: Record<string, string> = { [`${POOL}|${CMPT}`]: pool.publicKey, [`${POOL}|${FOREIGN}`]: pool.publicKey, [`${OTHER}|${CMPT}`]: pool.publicKey }
  const reader: LedgerReader = {
    tx: async (h) => txs[h] ?? null,
    encryptionKey: async (account, issuance) => keys[`${account}|${issuance}`],
  }
  const proofs = o.proof !== false
  const outProof = proofs ? await makeAmountProof({ txHash: D, field: 'DestinationEncryptedAmount', ciphertext: ctOut, amountMinor: 1200, key: pool }) : undefined
  const inProof = proofs ? await makeAmountProof({ txHash: P, field: 'SenderEncryptedAmount', ciphertext: ctIn, amountMinor: 995, key: pool }) : undefined
  const unsigned: UnsignedStatement = {
    id: 'stm_1',
    createdAt: '2026-11-21T10:00:00.000Z',
    holder: { displayName: 'Ana Ferri', handle: 'ana', address: o.holder ?? ANA },
    lines: [
      { activityId: 'act_out', date: '2026-11-21T09:00:00.000Z', counterparty: 'Carla Rossi', direction: 'out', amountMinor: o.amountMinor ?? 1200, feeMinor: 0, depositTxHash: D, network: 'devnet', ...(outProof ? { amountProof: outProof } : {}) },
      { activityId: 'act_in', date: '2026-11-21T09:30:00.000Z', counterparty: 'Bruno Bianchi', direction: 'in', amountMinor: 995, feeMinor: 5, payoutTxHash: P, network: 'devnet', ...(inProof ? { amountProof: inProof } : {}) },
    ],
    attestation: proofs ? 'proof' : 'zecca',
  }
  return { s: signStatement(unsigned, key), unsigned, reader, txs, keys }
}

describe('checkStatement (what an outside reader runs)', () => {
  it('signature by the pinned signer, every hash on the ledger, and both amounts proven against the pool key on the ledger', async () => {
    const { s, reader } = await fixture()
    const r = await checkStatement(s, reader, anchors)
    expect(r.ok).toBe(true)
    expect(r.signer).toBe('pinned')
    expect(r.signature).toEqual({ ok: true, signerAddress: key.address })
    expect(r.lines).toMatchObject([
      { activityId: 'act_out', transactions: 'ok', amount: 'proven' },
      { activityId: 'act_in', transactions: 'ok', amount: 'proven' },
    ])
  })

  it('lines without proof are attested by Zecca; the statement still checks', async () => {
    const { s, reader } = await fixture({ proof: false })
    const r = await checkStatement(s, reader, anchors)
    expect(r.ok).toBe(true)
    expect(r.lines.map((l) => l.amount)).toEqual(['attested', 'attested'])
  })

  it('fails when the signature does not match the content', async () => {
    const { s, reader } = await fixture()
    const tampered: Statement = { ...s, holder: { ...s.holder, displayName: 'Someone else' } }
    expect((await checkStatement(tampered, reader, anchors)).ok).toBe(false)
  })

  it('fails when the key the pool registered on the ledger is not the key in the proof', async () => {
    const { s, reader, keys } = await fixture()
    keys[`${POOL}|${CMPT}`] = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })).publicKey
    const r = await checkStatement(s, reader, anchors)
    expect(r.ok).toBe(false)
    expect(r.lines[0]).toMatchObject({ amount: 'invalid' })
  })

  it('fails when a hash is missing on the ledger or did not succeed', async () => {
    const { s, reader, txs } = await fixture({ proof: false })
    delete txs[P]
    expect(await checkStatement(s, reader, anchors)).toMatchObject({ ok: false, lines: [{ transactions: 'ok' }, { transactions: 'missing' }] })
    const f = await fixture({ proof: false })
    f.txs[D] = { ...f.txs[D], engineResult: 'tecBAD_PROOF' }
    expect(await checkStatement(f.s, f.reader, anchors)).toMatchObject({ ok: false, lines: [{ transactions: 'failed' }, { transactions: 'ok' }] })
  })

  it('fails when the proof names a different transaction than the line', async () => {
    const { unsigned, reader } = await fixture()
    const moved = signStatement({ ...unsigned, lines: [{ ...unsigned.lines[0], depositTxHash: P }] }, key)
    expect((await checkStatement(moved, reader, anchors)).lines[0].amount).toBe('invalid')
  })

  describe('the proven payment belongs to the holder and to Zecca', () => {
    it("an out line whose deposit was sent by another account is refused (someone else's payment)", async () => {
      const { s, reader } = await fixture({ deposit: { Account: OTHER } })
      const r = await checkStatement(s, reader, anchors)
      expect(r.ok).toBe(false)
      expect(r.lines[0]).toMatchObject({ transactions: 'ok', amount: 'invalid' })
    })

    it('an in line whose payout went to another account is refused', async () => {
      const { s, reader } = await fixture({ payout: { Destination: OTHER } })
      const r = await checkStatement(s, reader, anchors)
      expect(r.ok).toBe(false)
      expect(r.lines[1]).toMatchObject({ amount: 'invalid' })
    })

    it('a deposit that did not go to the pinned pool is refused, even with a key registered for its destination', async () => {
      const { s, reader } = await fixture({ deposit: { Destination: OTHER } })
      expect((await checkStatement(s, reader, anchors)).lines[0]).toMatchObject({ amount: 'invalid' })
    })

    it('a payout not sent by the pinned pool is refused', async () => {
      const { s, reader } = await fixture({ payout: { Account: OTHER } })
      expect((await checkStatement(s, reader, anchors)).lines[1]).toMatchObject({ amount: 'invalid' })
    })

    it("a payment in another issuance than Zecca's is refused", async () => {
      const { s, reader } = await fixture({ deposit: { MPTokenIssuanceID: FOREIGN } })
      const r = await checkStatement(s, reader, anchors)
      expect(r.ok).toBe(false)
      expect(r.lines[0]).toMatchObject({ amount: 'invalid' })
    })

    it('a proof of the wrong side of the payment is refused', async () => {
      const { unsigned, reader, txs } = await fixture()
      const ct = String(txs[D].tx.DestinationEncryptedAmount)
      txs[D].tx.SenderEncryptedAmount = ct
      const wrongSide = await makeAmountProof({ txHash: D, field: 'SenderEncryptedAmount', ciphertext: ct, amountMinor: 1200, key: pool })
      const s = signStatement({ ...unsigned, lines: [{ ...unsigned.lines[0], amountProof: wrongSide }] }, key)
      expect((await checkStatement(s, reader, anchors)).lines[0]).toMatchObject({ amount: 'invalid' })
    })

    it("Ana's genuine proven line copied into a statement for another holder is refused, whoever signed it", async () => {
      const ana = await fixture()
      const mallory = newKey()
      const lifted = signStatement({ ...ana.unsigned, holder: { displayName: 'Mallory', handle: 'mallory', address: OTHER } }, mallory)
      const r = await checkStatement(lifted, ana.reader, { ...anchors, signer: mallory.address })
      expect(r.ok).toBe(false)
      expect(r.lines.map((l) => l.amount)).toEqual(['invalid', 'invalid'])
    })
  })

  describe('the signer is pinned', () => {
    it('without a pinned signer the statement does not check, even when everything else holds', async () => {
      const { s, reader } = await fixture()
      const r = await checkStatement(s, reader, { pool: POOL, issuanceId: CMPT })
      expect(r).toMatchObject({ ok: false, signer: 'unpinned', signature: { ok: true } })
      expect(r.lines.map((l) => l.amount)).toEqual(['proven', 'proven'])
    })

    it('a statement signed by any other key does not check', async () => {
      const { unsigned, reader } = await fixture()
      const forged = signStatement(unsigned, newKey())
      expect(await checkStatement(forged, reader, anchors)).toMatchObject({ ok: false, signer: 'mismatch', signature: { ok: true } })
    })
  })
})

describe('anchorsFrom (what the reader trusts)', () => {
  it("takes the pool and issuance from Zecca's public config, and the statement signer when the config publishes it", () => {
    expect(anchorsFrom({ addresses: { pool: POOL, sponsor: ANA, issuer: ANA }, issuanceId: CMPT })).toEqual({ pool: POOL, issuanceId: CMPT })
    expect(anchorsFrom({ addresses: { pool: POOL, statementSigner: key.address }, issuanceId: CMPT })).toEqual({ pool: POOL, issuanceId: CMPT, signer: key.address })
  })

  it('values pinned by hand win over the config; nothing readable gives nothing', () => {
    expect(anchorsFrom({ addresses: { pool: POOL, statementSigner: ANA }, issuanceId: CMPT }, { signer: key.address, pool: OTHER })).toEqual({ pool: OTHER, issuanceId: CMPT, signer: key.address })
    expect(anchorsFrom(undefined)).toEqual({})
    expect(anchorsFrom({ addresses: { pool: 7 }, issuanceId: null })).toEqual({})
  })
})
