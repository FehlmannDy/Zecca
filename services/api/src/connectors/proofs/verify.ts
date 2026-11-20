// What an outside reader runs on a statement, trusting only the public ledger and three values they pin themselves (the
// trust anchors): Zecca's statement signer address, Zecca's pool address and Zecca's dollar issuance id. It checks the
// signature is by that signer, each transaction hash is validated with tesSUCCESS, and each amount proof against the
// ciphertext in a payment between the statement's holder and the pool, in Zecca's issuance, under the encryption key the
// pool registered on the ledger (its MPToken entry). Reads go through a LedgerReader, so the same logic runs against any
// XRPL node (verify-cli.ts) or a test double.
import type { Statement } from '@zecca/contracts'
import { parseAmountProof, verifyAmountProof, type ProofField } from './amount-proof'
import { verifyStatement, type VerifyResult } from './statement'

export type LedgerReader = {
  tx(hash: string): Promise<{ validated: boolean; engineResult: string; tx: Record<string, unknown> } | null>
  /** The HolderEncryptionKey of `account`'s MPToken for the issuance (validated ledger). */
  encryptionKey(account: string, issuanceId: string): Promise<string | undefined>
}

/** What the reader trusts. Without `signer` a statement never checks: any key can sign a well-formed statement. */
export type TrustAnchors = { signer?: string; pool: string; issuanceId: string }

export type LineCheck = {
  activityId: string
  transactions: 'ok' | 'missing' | 'failed'
  amount: 'proven' | 'attested' | 'invalid'
  detail?: string
}

export type StatementCheck = { ok: boolean; signature: VerifyResult; signer: 'pinned' | 'mismatch' | 'unpinned'; lines: LineCheck[] }

type Line = Statement['lines'][number]

/** The pool's side of a line's payment: the deposit to the pool (out) or the payout from it (in). */
function provenSide(line: Line, holder: string, pool: string): { hash?: string; field: ProofField; from: string; to: string } {
  return line.direction === 'out'
    ? { hash: line.depositTxHash, field: 'DestinationEncryptedAmount', from: holder, to: pool }
    : { hash: line.payoutTxHash, field: 'SenderEncryptedAmount', from: pool, to: holder }
}

async function checkLine(line: Line, holder: string, a: TrustAnchors, reader: LedgerReader): Promise<LineCheck> {
  const hashes = [line.depositTxHash, line.payoutTxHash].filter((h): h is string => !!h)
  const txs = new Map<string, Record<string, unknown>>()
  let transactions: LineCheck['transactions'] = 'ok'
  for (const h of hashes) {
    const t = await reader.tx(h)
    if (!t) transactions = 'missing'
    else if (!t.validated || t.engineResult !== 'tesSUCCESS') transactions = transactions === 'missing' ? 'missing' : 'failed'
    else txs.set(h, t.tx)
  }
  const base = { activityId: line.activityId, transactions }
  if (!line.amountProof) return { ...base, amount: 'attested' }
  const invalid = (detail: string): LineCheck => ({ ...base, amount: 'invalid', detail })

  const p = parseAmountProof(line.amountProof)
  if (!p) return invalid('The amount proof is not readable.')
  const side = provenSide(line, holder, a.pool)
  if (p.txHash !== side.hash) return invalid('The amount proof is for another transaction.')
  if (p.field !== side.field) return invalid('The amount proof is for the wrong side of the payment.')
  const tx = txs.get(p.txHash)
  if (!tx) return invalid('The proven transaction is not on the ledger.')
  if (tx.TransactionType !== 'ConfidentialMPTSend') return invalid('The proven transaction is not a confidential payment.')
  if (tx.Account !== side.from || tx.Destination !== side.to)
    return invalid(`The proven payment is not from ${side.from} to ${side.to} (the statement's holder and Zecca's pool).`)
  if (String(tx.MPTokenIssuanceID ?? '').toUpperCase() !== a.issuanceId.toUpperCase()) return invalid("The proven payment is not in Zecca's issuance.")
  const registered = await reader.encryptionKey(a.pool, a.issuanceId)
  if (!registered || registered.toUpperCase() !== p.publicKey) return invalid(`The key is not the one ${a.pool} registered on the ledger.`)
  const ok = await verifyAmountProof({ amountProof: line.amountProof, amountMinor: line.amountMinor, ciphertext: String(tx[p.field] ?? ''), publicKey: registered })
  return ok ? { ...base, amount: 'proven', detail: `Proven against ${p.field} of ${p.txHash}, key of ${a.pool}.` } : invalid('The amount proof does not hold.')
}

export async function checkStatement(s: Statement, reader: LedgerReader, anchors: TrustAnchors): Promise<StatementCheck> {
  const signature = verifyStatement(s)
  const signer: StatementCheck['signer'] = !anchors.signer ? 'unpinned' : signature.ok && signature.signerAddress === anchors.signer ? 'pinned' : 'mismatch'
  const lines: LineCheck[] = []
  for (const l of s.lines) lines.push(await checkLine(l, s.holder.address, anchors, reader))
  const ok = signature.ok && signer === 'pinned' && lines.every((l) => l.transactions === 'ok' && l.amount !== 'invalid')
  return { ok, signature, signer, lines }
}

/**
 * Trust anchors from Zecca's public config (GET /v1/config: addresses.pool, issuanceId, and addresses.statementSigner
 * once the config publishes it), overridden by what the reader pins by hand. Unreadable values are left out.
 */
export function anchorsFrom(config: unknown, pinned: Partial<TrustAnchors> = {}): Partial<TrustAnchors> {
  const c = (config ?? {}) as { addresses?: { pool?: unknown; statementSigner?: unknown }; issuanceId?: unknown }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const out: Partial<TrustAnchors> = {}
  const pool = pinned.pool ?? str(c.addresses?.pool)
  const issuanceId = pinned.issuanceId ?? str(c.issuanceId)
  const signer = pinned.signer ?? str(c.addresses?.statementSigner)
  if (pool) out.pool = pool
  if (issuanceId) out.issuanceId = issuanceId
  if (signer) out.signer = signer
  return out
}
