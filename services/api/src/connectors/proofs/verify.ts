// What an outside reader runs on a statement, trusting only the public ledger: Zecca's signature over the content, each
// transaction hash validated with tesSUCCESS, and each amount proof checked against the ciphertext in that transaction and
// the encryption key the pool registered on the ledger (its MPToken entry). Reads go through a LedgerReader, so the same
// logic runs against any XRPL node (verify-cli.ts) or a test double.
import type { Statement } from '@zecca/contracts'
import { parseAmountProof, verifyAmountProof } from './amount-proof'
import { verifyStatement, type VerifyResult } from './statement'

export type LedgerReader = {
  tx(hash: string): Promise<{ validated: boolean; engineResult: string; tx: Record<string, unknown> } | null>
  /** The HolderEncryptionKey of `account`'s MPToken for the issuance (validated ledger). */
  encryptionKey(account: string, issuanceId: string): Promise<string | undefined>
}

export type LineCheck = {
  activityId: string
  transactions: 'ok' | 'missing' | 'failed'
  amount: 'proven' | 'attested' | 'invalid'
  detail?: string
}

export type StatementCheck = { ok: boolean; signature: VerifyResult; signerMismatch?: boolean; lines: LineCheck[] }

type Line = Statement['lines'][number]

async function checkLine(line: Line, reader: LedgerReader): Promise<LineCheck> {
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

  const p = parseAmountProof(line.amountProof)
  if (!p) return { ...base, amount: 'invalid', detail: 'The amount proof is not readable.' }
  const expectedHash = line.direction === 'out' ? line.depositTxHash : line.payoutTxHash
  if (p.txHash !== expectedHash) return { ...base, amount: 'invalid', detail: 'The amount proof is for another transaction.' }
  const tx = txs.get(p.txHash)
  if (!tx) return { ...base, amount: 'invalid', detail: 'The proven transaction is not on the ledger.' }
  const account = String(p.field === 'DestinationEncryptedAmount' ? tx.Destination : tx.Account)
  const registered = await reader.encryptionKey(account, String(tx.MPTokenIssuanceID ?? ''))
  if (!registered || registered.toUpperCase() !== p.publicKey) return { ...base, amount: 'invalid', detail: `The key is not the one ${account} registered on the ledger.` }
  const ok = await verifyAmountProof({ amountProof: line.amountProof, amountMinor: line.amountMinor, ciphertext: String(tx[p.field] ?? ''), publicKey: registered })
  return ok ? { ...base, amount: 'proven', detail: `Proven against ${p.field} of ${p.txHash}, key of ${account}.` } : { ...base, amount: 'invalid', detail: 'The amount proof does not hold.' }
}

export async function checkStatement(s: Statement, reader: LedgerReader, opts: { expectedSigner?: string } = {}): Promise<StatementCheck> {
  const signature = verifyStatement(s)
  const signerMismatch = !!opts.expectedSigner && (!signature.ok || signature.signerAddress !== opts.expectedSigner)
  const lines: LineCheck[] = []
  for (const l of s.lines) lines.push(await checkLine(l, reader))
  const ok = signature.ok && !signerMismatch && lines.every((l) => l.transactions === 'ok' && l.amount !== 'invalid')
  return { ok, signature, ...(signerMismatch ? { signerMismatch } : {}), lines }
}
