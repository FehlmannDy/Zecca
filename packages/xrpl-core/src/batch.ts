// Batch (XLS-56) builder. Ported from privy-xrpl-probe probe.mjs:86 / web/server.mjs:64 (batchSigner, byAccountId)
// and the onboarding Batch of web/server.mjs:75, with every gotcha from HANDOFF "privy-xrpl-probe / Gotchas":
//  - inner txs: tfInnerBatchTxn, Fee "0", SigningPubKey "", no signature, explicit Sequence (autofill would be wrong for
//    the outer account and Convert proofs bind the sequence)
//  - an inner tx with a reserve Sponsor needs the placeholder SponsorSignature { SigningPubKey: '' } (not {})
//  - BatchSigners: every other inner account AND every inner sponsor, outer account excluded, sorted by AccountID bytes
import xrpl from 'xrpl'
import * as rk from 'ripple-keypairs'
import { encodeForSigningBatch } from 'ripple-binary-codec'
import { decodeAccountID } from 'ripple-address-codec'
import type { UnsignedTx } from '@zecca/contracts'

export const tfInnerBatchTxn = 0x40000000
export const tfAllOrNothing = 0x10000
export const tfSponsorCreatedAccount = 0x80000
export const spfFee = 1
export const spfReserve = 2

/** Transaction types that cost base + 9 x base (xrpl.js autofill CONFIDENTIAL_FEE_MULTIPLIER). */
export const CONFIDENTIAL_TX_TYPES = ['ConfidentialMPTConvert', 'ConfidentialMPTConvertBack', 'ConfidentialMPTSend', 'ConfidentialMPTClawback', 'ConfidentialMPTMergeInbox']

type Tx = Record<string, unknown>
export type BatchSignerEntry = { BatchSigner: { Account: string; SigningPubKey: string; TxnSignature: string } }
// Loose on purpose: callers pass decoded blobs, UnsignedTx or xrpl.js Batch objects.
type BatchLike = Record<string, any>

const acctBytes = (a: string) => Buffer.from(decodeAccountID(a))
export const byAccountId = (a: BatchSignerEntry, b: BatchSignerEntry) => Buffer.compare(acctBytes(a.BatchSigner.Account), acctBytes(b.BatchSigner.Account))

/** The bytes a BatchSigner signs: outer account, sequence, flags, and the hashes of the inner txs. */
export function batchSigningPayload(batch: BatchLike, batchAccount: string): string {
  const txIDs = (batch.RawTransactions as { RawTransaction: Tx }[]).map((r) => xrpl.hashes.hashSignedTx(r.RawTransaction as never))
  return encodeForSigningBatch({ account: batch.Account, sequence: batch.Sequence ?? 0, flags: batch.Flags ?? 0, txIDs, batchAccount } as never)
}

export function batchSigner(wallet: xrpl.Wallet, batch: BatchLike): BatchSignerEntry {
  return {
    BatchSigner: {
      Account: wallet.classicAddress,
      SigningPubKey: wallet.publicKey,
      TxnSignature: rk.sign(batchSigningPayload(batch, wallet.classicAddress), wallet.privateKey),
    },
  }
}

/** Accounts that must add a BatchSigner: every inner account and inner sponsor other than the outer account. */
export function requiredBatchSigners(batch: BatchLike): Set<string> {
  const out = new Set<string>()
  for (const { RawTransaction: t } of batch.RawTransactions as { RawTransaction: Tx }[]) {
    if (t.Account !== batch.Account) out.add(String(t.Account))
    if (t.Sponsor && t.Sponsor !== batch.Account) out.add(String(t.Sponsor))
  }
  return out
}

/** Same as xrpl.js autofill for a Batch: 2 x base + each inner's own cost + base per BatchSigner. */
export function batchFeeDrops(baseFeeDrops: number, inners: Tx[], signersCount: number): number {
  const innerFee = (t: Tx) => (CONFIDENTIAL_TX_TYPES.includes(String(t.TransactionType)) ? baseFeeDrops * 10 : baseFeeDrops)
  return baseFeeDrops * 2 + inners.reduce((s, t) => s + innerFee(t), 0) + baseFeeDrops * signersCount
}

export type BuildBatchParams = {
  /** Outer fields. Account and Sequence are required; Fee is computed from baseFeeDrops when absent. */
  outer: Tx & { Account: string; Sequence: number }
  /** Inner txs with explicit Sequence. An inner with Sponsor (+ SponsorFlags spfReserve) gets the placeholder SponsorSignature. */
  inners: Tx[]
  /** Pays the outer fee (Sponsor + SponsorFlags spfFee on the outer tx; co-signs after the user). */
  sponsor?: string
  /** Wallets that add BatchSigners. Must be exactly the required set. */
  cosigners: xrpl.Wallet[]
  baseFeeDrops?: number
}

export function buildBatch(p: BuildBatchParams): UnsignedTx {
  if (!p.inners.length) throw new Error('a Batch needs at least one inner transaction')
  const inners = p.inners.map((t0, i) => {
    const t: Tx = structuredClone(t0)
    if (t.TxnSignature || t.Signers) throw new Error(`inner #${i} ${t.TransactionType} is already signed`)
    if (t.Fee != null && t.Fee !== '0') throw new Error(`inner #${i} ${t.TransactionType} must have Fee "0"`)
    if (typeof t.Sequence !== 'number' && typeof t.TicketSequence !== 'number') throw new Error(`inner #${i} ${t.TransactionType} needs an explicit Sequence`)
    t.Flags = (Number(t.Flags ?? 0) | tfInnerBatchTxn) >>> 0
    t.Fee = '0'
    t.SigningPubKey = ''
    if (t.Sponsor) t.SponsorSignature = { SigningPubKey: '' }
    return t
  })
  const batch: Tx = {
    ...structuredClone(p.outer),
    TransactionType: 'Batch',
    Flags: Number(p.outer.Flags ?? tfAllOrNothing),
    RawTransactions: inners.map((RawTransaction) => ({ RawTransaction })),
  }
  if (p.sponsor) Object.assign(batch, { Sponsor: p.sponsor, SponsorFlags: spfFee })

  const need = requiredBatchSigners(batch)
  const have = new Set(p.cosigners.map((w) => w.classicAddress))
  for (const a of need) if (!have.has(a)) throw new Error(`missing BatchSigner for ${a}`)
  for (const a of have) if (!need.has(a)) throw new Error(`cosigner ${a} is not needed by this Batch`)
  if (batch.Fee == null) batch.Fee = String(batchFeeDrops(p.baseFeeDrops ?? 10, inners, need.size))
  batch.BatchSigners = p.cosigners.map((w) => batchSigner(w, batch)).sort(byAccountId)
  return batch as UnsignedTx
}
