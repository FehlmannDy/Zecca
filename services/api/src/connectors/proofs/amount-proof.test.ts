import { describe, expect, it } from 'vitest'
import * as rk from 'ripple-keypairs'
import { encryptAmount, generateBlindingFactor } from '@xrplf/mpt-crypto'
import type { ElGamalKeyPair, LedgerTxEvent } from '@zecca/contracts'
import { amountContext, makeAmountProof, parseAmountProof, proveLine, verifyAmountProof } from './amount-proof'

const elgamal = (): ElGamalKeyPair => {
  const kp = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' }))
  return { publicKey: kp.publicKey, privateKey: kp.privateKey.slice(2) }
}
const pool = elgamal()
const POOL = 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ'
const ANA = 'rB5Pc1c7EYx98o4iWfk4Jx96JrCWgqhfZ3'
const H1 = 'A'.repeat(64)
const H2 = 'B'.repeat(64)
const enc = async (amount: number, pub = pool.publicKey) => encryptAmount(BigInt(amount), pub, await generateBlindingFactor())

describe('amount proof (plaintext-equality sigma proof from @xrplf/mpt-crypto)', () => {
  it('proves that a ciphertext under the pool key encrypts exactly the amount, without the private key', async () => {
    const ct = await enc(1200)
    const p = await makeAmountProof({ txHash: H1, field: 'DestinationEncryptedAmount', ciphertext: ct, amountMinor: 1200, key: pool })
    expect(parseAmountProof(p)).toMatchObject({ txHash: H1, field: 'DestinationEncryptedAmount', publicKey: pool.publicKey })
    expect(p).not.toContain(pool.privateKey)
    expect(await verifyAmountProof({ amountProof: p, amountMinor: 1200, ciphertext: ct })).toBe(true)
  })

  it('fails for another amount, another ciphertext, another key, or a proof moved to another transaction', async () => {
    const ct = await enc(1200)
    const p = await makeAmountProof({ txHash: H1, field: 'DestinationEncryptedAmount', ciphertext: ct, amountMinor: 1200, key: pool })
    expect(await verifyAmountProof({ amountProof: p, amountMinor: 1201, ciphertext: ct })).toBe(false)
    expect(await verifyAmountProof({ amountProof: p, amountMinor: 1200, ciphertext: await enc(1200) })).toBe(false)
    expect(await verifyAmountProof({ amountProof: p, amountMinor: 1200, ciphertext: ct, publicKey: elgamal().publicKey })).toBe(false)
    const moved = p.replace(H1, H2)
    expect(await verifyAmountProof({ amountProof: moved, amountMinor: 1200, ciphertext: ct })).toBe(false)
  })

  it('the WASM verifier itself refuses a proof whose key was swapped for another one (not only the string check)', async () => {
    const ct = await enc(1200)
    const other = elgamal()
    const p = await makeAmountProof({ txHash: H1, field: 'DestinationEncryptedAmount', ciphertext: ct, amountMinor: 1200, key: pool })
    const swapped = p.replace(pool.publicKey.toUpperCase(), other.publicKey.toUpperCase())
    expect(parseAmountProof(swapped)?.publicKey).toBe(other.publicKey.toUpperCase())
    expect(await verifyAmountProof({ amountProof: swapped, amountMinor: 1200, ciphertext: ct, publicKey: other.publicKey })).toBe(false)
    expect(await verifyAmountProof({ amountProof: swapped, amountMinor: 1200, ciphertext: ct })).toBe(false)
  })

  it('an amount of 0 is proven and checked like any other', async () => {
    const ct = await enc(0)
    const p = await makeAmountProof({ txHash: H1, field: 'SenderEncryptedAmount', ciphertext: ct, amountMinor: 0, key: pool })
    expect(await verifyAmountProof({ amountProof: p, amountMinor: 0, ciphertext: ct, publicKey: pool.publicKey })).toBe(true)
    expect(await verifyAmountProof({ amountProof: p, amountMinor: 1, ciphertext: ct, publicKey: pool.publicKey })).toBe(false)
  })

  it('the context hash binds tx, field and amount', () => {
    expect(amountContext(H1, 'DestinationEncryptedAmount', 1200)).toMatch(/^[0-9A-F]{64}$/)
    expect(amountContext(H1, 'DestinationEncryptedAmount', 1200)).not.toBe(amountContext(H1, 'SenderEncryptedAmount', 1200))
    expect(amountContext(H1, 'DestinationEncryptedAmount', 1200)).not.toBe(amountContext(H1, 'DestinationEncryptedAmount', 1201))
  })

  it('malformed proofs are refused, not thrown', async () => {
    expect(parseAmountProof('nope')).toBeUndefined()
    expect(parseAmountProof(`mpt-dleq-v1:${H1}:Memo:${pool.publicKey}:${'00'.repeat(64)}`)).toBeUndefined()
    expect(await verifyAmountProof({ amountProof: 'nope', amountMinor: 1, ciphertext: await enc(1) })).toBe(false)
    expect(await verifyAmountProof({ amountProof: `mpt-dleq-v1:${H1}:DestinationEncryptedAmount:${pool.publicKey}:${'00'.repeat(64)}`, amountMinor: 1, ciphertext: 'zz' })).toBe(false)
  })
})

describe('proveLine (from the ledger transaction)', () => {
  const ledgerOf = (txs: Record<string, LedgerTxEvent>) => ({ txByHash: async (h: string) => txs[h] ?? null })
  const send = (hash: string, tx: Record<string, unknown>, ok = true): LedgerTxEvent => ({
    hash,
    ledgerIndex: 10,
    validated: ok,
    engineResult: ok ? 'tesSUCCESS' : 'tecBAD_PROOF',
    tx: { TransactionType: 'ConfidentialMPTSend', ...tx },
  })

  it('out line: the deposit to the pool (DestinationEncryptedAmount)', async () => {
    const ct = await enc(1200)
    const ledger = ledgerOf({ [H1]: send(H1, { Account: ANA, Destination: POOL, DestinationEncryptedAmount: ct }) })
    const p = await proveLine({ ledger, poolAddress: POOL, poolKey: pool }, { direction: 'out', amountMinor: 1200, depositTxHash: H1 })
    expect(parseAmountProof(p!)).toMatchObject({ txHash: H1, field: 'DestinationEncryptedAmount' })
    expect(await verifyAmountProof({ amountProof: p!, amountMinor: 1200, ciphertext: ct })).toBe(true)
  })

  it('in line: the payout from the pool (SenderEncryptedAmount)', async () => {
    const ct = await enc(995)
    const ledger = ledgerOf({ [H2]: send(H2, { Account: POOL, Destination: ANA, SenderEncryptedAmount: ct, DestinationEncryptedAmount: await enc(995, elgamal().publicKey) }) })
    const p = await proveLine({ ledger, poolAddress: POOL, poolKey: pool }, { direction: 'in', amountMinor: 995, depositTxHash: H1, payoutTxHash: H2 })
    expect(parseAmountProof(p!)).toMatchObject({ txHash: H2, field: 'SenderEncryptedAmount' })
  })

  it('no proof when it cannot be true: wrong amount, failed or missing tx, not a pool send, mock ciphertexts', async () => {
    const ct = await enc(1200)
    const deps = (txs: Record<string, LedgerTxEvent>) => ({ ledger: ledgerOf(txs), poolAddress: POOL, poolKey: pool })
    const line = { direction: 'out' as const, amountMinor: 1300, depositTxHash: H1 }
    expect(await proveLine(deps({ [H1]: send(H1, { Account: ANA, Destination: POOL, DestinationEncryptedAmount: ct }) }), line)).toBeUndefined()
    expect(await proveLine(deps({ [H1]: send(H1, { Account: ANA, Destination: POOL, DestinationEncryptedAmount: ct }, false) }), { ...line, amountMinor: 1200 })).toBeUndefined()
    expect(await proveLine(deps({}), { ...line, amountMinor: 1200 })).toBeUndefined()
    expect(await proveLine(deps({ [H1]: send(H1, { Account: ANA, Destination: ANA, DestinationEncryptedAmount: ct }) }), { ...line, amountMinor: 1200 })).toBeUndefined()
    const mock = '02' + (1200).toString(16).padStart(130, '0').toUpperCase()
    expect(await proveLine(deps({ [H1]: send(H1, { Account: ANA, Destination: POOL, DestinationEncryptedAmount: mock }) }), { ...line, amountMinor: 1200 })).toBeUndefined()
    expect(await proveLine(deps({}), { direction: 'in', amountMinor: 1 })).toBeUndefined()
    const throwing = { ledger: { txByHash: async () => Promise.reject(new Error('down')) }, poolAddress: POOL, poolKey: pool }
    expect(await proveLine(throwing, { ...line, amountMinor: 1200 })).toBeUndefined()
  })
})
