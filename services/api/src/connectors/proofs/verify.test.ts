import { describe, expect, it } from 'vitest'
import * as rk from 'ripple-keypairs'
import { encryptAmount, generateBlindingFactor } from '@xrplf/mpt-crypto'
import type { Statement } from '@zecca/contracts'
import { makeAmountProof } from './amount-proof'
import { signStatement, statementKeyFrom, type UnsignedStatement } from './statement'
import { checkStatement, type LedgerReader } from './verify'

const kp = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' }))
const pool = { publicKey: kp.publicKey, privateKey: kp.privateKey.slice(2) }
const POOL = 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ'
const ANA = 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3'
const CMPT = '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9'
const D = 'D'.repeat(64)
const P = 'E'.repeat(64)
const seed = rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })
const key = statementKeyFrom({ address: rk.deriveAddress(rk.deriveKeypair(seed).publicKey), seed, algorithm: 'ecdsa-secp256k1' })

async function fixture(o: { proof?: boolean; amountMinor?: number } = {}) {
  const ct = await encryptAmount(1200n, pool.publicKey, await generateBlindingFactor())
  const txs: Record<string, { validated: boolean; engineResult: string; tx: Record<string, unknown> }> = {
    [D]: { validated: true, engineResult: 'tesSUCCESS', tx: { TransactionType: 'ConfidentialMPTSend', Account: ANA, Destination: POOL, MPTokenIssuanceID: CMPT, DestinationEncryptedAmount: ct } },
    [P]: { validated: true, engineResult: 'tesSUCCESS', tx: { TransactionType: 'ConfidentialMPTSend', Account: POOL, Destination: 'rCarla', MPTokenIssuanceID: CMPT } },
  }
  const keys: Record<string, string> = { [`${POOL}|${CMPT}`]: pool.publicKey }
  const reader: LedgerReader = {
    tx: async (h) => txs[h] ?? null,
    encryptionKey: async (account, issuance) => keys[`${account}|${issuance}`],
  }
  const amountProof = o.proof === false ? undefined : await makeAmountProof({ txHash: D, field: 'DestinationEncryptedAmount', ciphertext: ct, amountMinor: 1200, key: pool })
  const unsigned: UnsignedStatement = {
    id: 'stm_1',
    createdAt: '2026-11-21T10:00:00.000Z',
    holder: { displayName: 'Ana Ferri', handle: 'ana', address: ANA },
    lines: [
      { activityId: 'act_1', date: '2026-11-21T09:00:00.000Z', counterparty: 'Carla Rossi', direction: 'out', amountMinor: o.amountMinor ?? 1200, feeMinor: 0, depositTxHash: D, payoutTxHash: P, network: 'devnet', ...(amountProof ? { amountProof } : {}) },
    ],
    attestation: amountProof ? 'proof' : 'zecca',
  }
  return { s: signStatement(unsigned, key), reader, txs, keys }
}

describe('checkStatement (what an outside reader runs)', () => {
  it('signature, both hashes on the ledger, and the amount proven against the key registered on the ledger', async () => {
    const { s, reader } = await fixture()
    const r = await checkStatement(s, reader)
    expect(r.ok).toBe(true)
    expect(r.signature).toEqual({ ok: true, signerAddress: key.address })
    expect(r.lines[0]).toMatchObject({ activityId: 'act_1', transactions: 'ok', amount: 'proven' })
  })

  it('a line without proof is attested by Zecca; the statement still checks', async () => {
    const { s, reader } = await fixture({ proof: false })
    const r = await checkStatement(s, reader)
    expect(r.ok).toBe(true)
    expect(r.lines[0].amount).toBe('attested')
  })

  it('fails when the signature does not match the content', async () => {
    const { s, reader } = await fixture()
    const tampered: Statement = { ...s, holder: { ...s.holder, displayName: 'Someone else' } }
    expect((await checkStatement(tampered, reader)).ok).toBe(false)
  })

  it('fails when the key in the proof is not the one the pool registered on the ledger', async () => {
    const { s, reader, keys } = await fixture()
    keys[`${POOL}|${CMPT}`] = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })).publicKey
    const r = await checkStatement(s, reader)
    expect(r.ok).toBe(false)
    expect(r.lines[0]).toMatchObject({ amount: 'invalid' })
  })

  it('fails when a hash is missing on the ledger or did not succeed', async () => {
    const { s, reader, txs } = await fixture({ proof: false })
    delete txs[P]
    expect(await checkStatement(s, reader)).toMatchObject({ ok: false, lines: [{ transactions: 'missing' }] })
    const f = await fixture({ proof: false })
    f.txs[D] = { ...f.txs[D], engineResult: 'tecBAD_PROOF' }
    expect(await checkStatement(f.s, f.reader)).toMatchObject({ ok: false, lines: [{ transactions: 'failed' }] })
  })

  it('fails when the proof names a different transaction than the line', async () => {
    const { s, reader } = await fixture()
    const moved = signStatement({ ...s, lines: [{ ...s.lines[0], depositTxHash: P, payoutTxHash: D }] }, key)
    expect((await checkStatement(moved, reader)).lines[0].amount).toBe('invalid')
  })

  it('can require a known signer address', async () => {
    const { s, reader } = await fixture()
    expect((await checkStatement(s, reader, { expectedSigner: key.address })).ok).toBe(true)
    expect((await checkStatement(s, reader, { expectedSigner: ANA })).ok).toBe(false)
  })
})
