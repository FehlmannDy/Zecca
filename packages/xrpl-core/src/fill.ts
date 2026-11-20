// Fills the fields a signer would otherwise autofill, so a user signer (Privy adapter) changes nothing (DECISIONS #5):
// Sequence, Fee, LastLedgerSequence, Sponsor + SponsorFlags, SigningPubKey. Fee rules mirror xrpl.js 5.3.0 autofill.
import type { UnsignedTx } from '@zecca/contracts'
import { batchFeeDrops, CONFIDENTIAL_TX_TYPES, spfFee, spfReserve } from './batch'

/** User txs: room for a human review in the Privy prompt (HANDOFF gotcha "LLS window"). */
export const USER_LLS_WINDOW = 150
/** Our own txs (xrpl.js default offset). */
export const OWN_LLS_WINDOW = 20
/** The Privy adapter refuses a fee above 2 XRP. */
export const MAX_USER_FEE_DROPS = 2_000_000

type Tx = Record<string, unknown>

export function feeDrops(tx: Tx, baseFeeDrops: number): number {
  if (tx.TransactionType === 'Batch') {
    const inners = ((tx.RawTransactions as { RawTransaction: Tx }[]) ?? []).map((r) => r.RawTransaction)
    return batchFeeDrops(baseFeeDrops, inners, ((tx.BatchSigners as unknown[]) ?? []).length)
  }
  return CONFIDENTIAL_TX_TYPES.includes(String(tx.TransactionType)) ? baseFeeDrops * 10 : baseFeeDrops
}

export type FillClient = { baseFeeDrops(): Promise<number>; ledgerIndex(): Promise<number>; nextSequence(address: string): Promise<number> }
export type FillOptions = {
  /** Sponsor address: sets Sponsor + SponsorFlags (fee, + reserve when `reserve`). Sponsored txs get the user LLS window. */
  sponsor?: string
  reserve?: boolean
  /** The user's public key, so the signing hash is known before signing. */
  publicKey?: string
  llsWindow?: number
}

export async function fillTx<T extends Tx>(client: FillClient, txIn: T, opts: FillOptions = {}): Promise<T & UnsignedTx> {
  const tx: Tx = structuredClone(txIn)
  if (opts.sponsor) Object.assign(tx, { Sponsor: opts.sponsor, SponsorFlags: spfFee | (opts.reserve ? spfReserve : 0) })
  if (opts.publicKey) tx.SigningPubKey = opts.publicKey
  const [seq, base, ledger] = await Promise.all([
    tx.Sequence == null && tx.TicketSequence == null ? client.nextSequence(String(tx.Account)) : undefined,
    tx.Fee == null ? client.baseFeeDrops() : undefined,
    tx.LastLedgerSequence == null ? client.ledgerIndex() : undefined,
  ])
  if (seq != null) tx.Sequence = seq
  if (base != null) tx.Fee = String(feeDrops(tx, base))
  if (ledger != null) tx.LastLedgerSequence = ledger + (opts.llsWindow ?? (opts.sponsor ? USER_LLS_WINDOW : OWN_LLS_WINDOW))
  if (Number(tx.Fee) > MAX_USER_FEE_DROPS) throw new Error(`fee ${String(tx.Fee)} drops is above the 2 XRP cap`)
  return tx as T & UnsignedTx
}
