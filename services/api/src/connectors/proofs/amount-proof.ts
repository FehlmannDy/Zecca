// Per-line amount proofs (SPEC §4.10 investigation, recorded in the agent's decisions).
//
// @xrplf/mpt-crypto@0.1.1 (mpt-crypto 1.0.5, the library rippled links) exposes getClawbackProof(priv, pub, ctx, amount,
// ciphertext): a 64-byte compact sigma proof that `ciphertext` decrypts under `pub` to exactly `amount`, made with the
// private key without revealing it. Its verifier, mpt_verify_clawback_proof(proof, amount, pub, ciphertext, ctx), is
// exported by the same WASM (reachable through the package's loadWasmModule(), not wrapped in its TypeScript API).
//
// Every payment goes through the pool, and Zecca holds the pool's encryption key. So for each line we prove the pool's
// side of the ledger transaction: the deposit's DestinationEncryptedAmount (out lines) or the payout's
// SenderEncryptedAmount (in lines). rippled already checked, when it validated that ConfidentialMPTSend, that all its
// ciphertexts encrypt the same amount under the participants' registered keys; so a reader who takes the ciphertext
// from the public ledger and the pool's key from its MPToken entry on the ledger learns the amount without trusting Zecca.
//
// Format: mpt-dleq-v1:<txHash>:<field>:<poolPublicKeyHex>:<proofHex>
// Context: SHA-256("zecca-amount-proof/v1|<txHash>|<field>|<amountMinor>"), uppercase hex (binds the proof to its line).
import { createHash } from 'node:crypto'
import { getClawbackProof, loadWasmModule } from '@xrplf/mpt-crypto'
import type { ElGamalKeyPair, Ledger } from '@zecca/contracts'

export const AMOUNT_PROOF_SCHEME = 'mpt-dleq-v1'
export const PROOF_FIELDS = ['DestinationEncryptedAmount', 'SenderEncryptedAmount'] as const
export type ProofField = (typeof PROOF_FIELDS)[number]
export type ParsedAmountProof = { txHash: string; field: ProofField; publicKey: string; proof: string }

const HEX = (bytes: number) => new RegExp(`^[0-9A-F]{${bytes * 2}}$`)
const isHex = (s: unknown, bytes: number): s is string => typeof s === 'string' && HEX(bytes).test(s)

export function amountContext(txHash: string, field: ProofField, amountMinor: number): string {
  return createHash('sha256').update(`zecca-amount-proof/v1|${txHash}|${field}|${amountMinor}`, 'utf8').digest('hex').toUpperCase()
}

export async function makeAmountProof(p: { txHash: string; field: ProofField; ciphertext: string; amountMinor: number; key: ElGamalKeyPair }): Promise<string> {
  const ctx = amountContext(p.txHash, p.field, p.amountMinor)
  const proof = await getClawbackProof(p.key.privateKey, p.key.publicKey, ctx, BigInt(p.amountMinor), p.ciphertext)
  return [AMOUNT_PROOF_SCHEME, p.txHash, p.field, p.key.publicKey.toUpperCase(), proof.toUpperCase()].join(':')
}

export function parseAmountProof(s: string): ParsedAmountProof | undefined {
  const parts = s.split(':')
  if (parts.length !== 5 || parts[0] !== AMOUNT_PROOF_SCHEME) return undefined
  const [, txHash, field, publicKey, proof] = parts
  if (!isHex(txHash, 32) || !(PROOF_FIELDS as readonly string[]).includes(field) || !isHex(publicKey, 33) || !isHex(proof, 64)) return undefined
  return { txHash, field: field as ProofField, publicKey, proof }
}

type VerifierModule = {
  HEAPU8: Uint8Array
  _malloc(n: number): number
  _free(p: number): void
  _mpt_verify_clawback_proof(proof: number, amount: bigint, pubkey: number, ciphertext: number, ctx: number): number
}

/** The WASM verifier, called directly (0 = valid). */
async function verifySigma(proof: string, amountMinor: number, publicKey: string, ciphertext: string, ctx: string): Promise<boolean> {
  if (!isHex(proof, 64) || !isHex(publicKey, 33) || !isHex(ciphertext, 66) || !isHex(ctx, 32)) return false
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return false
  const mod = (await loadWasmModule()) as unknown as VerifierModule
  const ptrs: number[] = []
  const put = (hex: string) => {
    const b = Uint8Array.from(Buffer.from(hex, 'hex'))
    const p = mod._malloc(b.length)
    ptrs.push(p)
    mod.HEAPU8.set(b, p)
    return p
  }
  try {
    return mod._mpt_verify_clawback_proof(put(proof), BigInt(amountMinor), put(publicKey), put(ciphertext), put(ctx)) === 0
  } finally {
    for (const p of ptrs) mod._free(p)
  }
}

/**
 * Checks a line's proof against a ciphertext. `publicKey` is the key the reader trusts (the pool's key read from the
 * ledger); without it the key embedded in the proof is used, which only says the proof is well formed.
 */
export async function verifyAmountProof(p: { amountProof: string; amountMinor: number; ciphertext: string; publicKey?: string }): Promise<boolean> {
  const parsed = parseAmountProof(p.amountProof)
  if (!parsed) return false
  const key = (p.publicKey ?? parsed.publicKey).toUpperCase()
  if (key !== parsed.publicKey) return false
  try {
    return await verifySigma(parsed.proof, p.amountMinor, key, String(p.ciphertext).toUpperCase(), amountContext(parsed.txHash, parsed.field, p.amountMinor))
  } catch {
    return false
  }
}

export type ProveDeps = { ledger: Pick<Ledger, 'txByHash'>; poolAddress: string; poolKey: ElGamalKeyPair }
export type ProvableLine = { direction: 'in' | 'out'; amountMinor: number; depositTxHash?: string; payoutTxHash?: string }

/** The pool-side proof for one line, or undefined when no true proof can be made (never throws). */
export async function proveLine(d: ProveDeps, line: ProvableLine): Promise<string | undefined> {
  const txHash = line.direction === 'out' ? line.depositTxHash : line.payoutTxHash
  if (!txHash) return undefined
  try {
    const ev = await d.ledger.txByHash(txHash)
    if (!ev || !ev.validated || ev.engineResult !== 'tesSUCCESS' || ev.tx.TransactionType !== 'ConfidentialMPTSend') return undefined
    const field: ProofField | undefined =
      line.direction === 'out' && ev.tx.Destination === d.poolAddress
        ? 'DestinationEncryptedAmount'
        : line.direction === 'in' && ev.tx.Account === d.poolAddress
          ? 'SenderEncryptedAmount'
          : undefined
    if (!field) return undefined
    const ciphertext = String(ev.tx[field] ?? '').toUpperCase()
    if (!isHex(ciphertext, 66)) return undefined
    const amountProof = await makeAmountProof({ txHash, field, ciphertext, amountMinor: line.amountMinor, key: d.poolKey })
    // Never publish a proof that does not hold (wrong amount, a ciphertext that is not ours, mock ledger data).
    return (await verifyAmountProof({ amountProof, amountMinor: line.amountMinor, ciphertext, publicKey: d.poolKey.publicKey })) ? amountProof : undefined
  } catch {
    return undefined
  }
}
