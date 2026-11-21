// PreparedTx storage and the sponsor policy (D11, SPEC §4.3). The sponsor co-signs only what we prepared, once, for its owner.
import { decode, encode, encodeForSigning } from 'ripple-binary-codec'
import * as rk from 'ripple-keypairs'
import { DEFAULTS, type PreparedTx, type TxKind, type UnsignedTx } from '@zecca/contracts'
import { sha512Half } from '@zecca/xrpl-core/signer'
import type { Core } from '../core'
import { Err } from '../errors'
import type { Session } from '../auth/sessions'
import { preparing } from './account-gate'

export type PreparedRow = {
  id: string
  address: string
  kind: TxKind
  tx: Record<string, unknown>
  unsignedBlob: string
  signingHash: string
  lastLedgerSequence?: number
  expiresAt: string
  usedAt?: string
  intentId?: string
  ledgerHash?: string
  engineResult?: string
}

type Raw = {
  id: string
  address: string
  kind: TxKind
  tx_json: string
  unsigned_blob: string
  signing_hash: string
  last_ledger_sequence: number | null
  expires_at: string
  used_at: string | null
  intent_id: string | null
  ledger_hash: string | null
  engine_result: string | null
}
const fromRaw = (r: Raw): PreparedRow => ({
  id: r.id,
  address: r.address,
  kind: r.kind,
  tx: JSON.parse(r.tx_json) as Record<string, unknown>,
  unsignedBlob: r.unsigned_blob,
  signingHash: r.signing_hash,
  lastLedgerSequence: r.last_ledger_sequence ?? undefined,
  expiresAt: r.expires_at,
  usedAt: r.used_at ?? undefined,
  intentId: r.intent_id ?? undefined,
  ledgerHash: r.ledger_hash ?? undefined,
  engineResult: r.engine_result ?? undefined,
})

/** The canonical unsigned encoding and the signing hash, with SigningPubKey set to the user's key (DECISIONS #5). */
export function signingForm(tx: Record<string, unknown>, publicKey: string): { tx: Record<string, unknown>; unsignedBlob: string; signingHash: string } {
  const t: Record<string, unknown> = { ...tx, SigningPubKey: publicKey.toUpperCase() }
  delete t.TxnSignature
  return { tx: t, unsignedBlob: encode(t as never), signingHash: sha512Half(encodeForSigning(t as never)) }
}

/** Ledger close time is 3 to 4 s: the approval stays valid while LastLedgerSequence can still be met. */
const MS_PER_LEDGER = 3_000

/**
 * Stores a PreparedTx. Pass `tx` as its builder: it is then built inside the account gate, after the account's relayer merge in
 * flight (so the Sequence is fresh), and no merge of that account starts until the row is stored (account-gate.ts).
 */
export function storePrepared(
  core: Core,
  p: { address: string; publicKey: string; kind: TxKind; tx: UnsignedTx | (() => Promise<UnsignedTx>); intentId?: string },
): Promise<PreparedTx> {
  return preparing(core, p.address, async () => insertPrepared(core, { ...p, tx: typeof p.tx === 'function' ? await p.tx() : p.tx }))
}

async function insertPrepared(core: Core, p: { address: string; publicKey: string; kind: TxKind; tx: UnsignedTx; intentId?: string }): Promise<PreparedTx> {
  const { tx, unsignedBlob, signingHash } = signingForm(p.tx, p.publicKey)
  const lls = typeof tx.LastLedgerSequence === 'number' ? tx.LastLedgerSequence : undefined
  const now = core.now()
  const current = lls !== undefined ? await core.ledger.ledgerIndex() : 0
  const ledgersLeft = lls !== undefined ? Math.max(0, lls - current) : DEFAULTS.LLS_WINDOW
  const expiresAt = core.iso(now + ledgersLeft * MS_PER_LEDGER)
  const id = core.id('prep')
  core.db
    .prepare(
      `INSERT INTO prepared_txs (id, address, kind, tx_json, unsigned_blob, signing_hash, last_ledger_sequence, expires_at, intent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, p.address, p.kind, JSON.stringify(tx), unsignedBlob, signingHash, lls ?? null, expiresAt, p.intentId ?? null, core.iso(now))
  return { prepareId: id, kind: p.kind, tx: tx as PreparedTx['tx'], expiresAt }
}

export function preparedById(core: Core, id: string): PreparedRow | undefined {
  const r = core.db.prepare('SELECT * FROM prepared_txs WHERE id = ?').get(id) as Raw | undefined
  return r && fromRaw(r)
}

export function preparedForIntent(core: Core, intentId: string): PreparedRow[] {
  return (core.db.prepare('SELECT * FROM prepared_txs WHERE intent_id = ? ORDER BY created_at').all(intentId) as Raw[]).map(fromRaw)
}

const REFUSED = {
  notYours: "This approval doesn't belong to your account. Start again.",
  mismatch: "This transaction doesn't match what you were asked to approve. Start again.",
  used: 'This approval was already used.',
  expired: 'This approval has expired. Start again.',
  unreadable: "That transaction couldn't be read. Start again.",
} as const

/**
 * The sponsor policy. Returns the PreparedRow when the blob is exactly the stored, unexpired, unused PreparedTx of this session,
 * signed by the session's key. Throws 403 policy_refused / signature_invalid otherwise. Does not mark it used.
 */
export async function checkSubmission(core: Core, session: Session, prepareId: string, txBlob: string): Promise<PreparedRow> {
  const p = preparedById(core, prepareId)
  if (!p || p.address !== session.address) throw Err.policy(REFUSED.notYours)

  let decoded: Record<string, unknown>
  try {
    decoded = decode(txBlob) as Record<string, unknown>
  } catch {
    throw Err.badRequest(REFUSED.unreadable)
  }
  if (decoded.Account !== session.address) throw Err.policy(REFUSED.notYours)
  if (typeof decoded.SigningPubKey !== 'string' || decoded.SigningPubKey.toUpperCase() !== session.publicKey.toUpperCase()) throw Err.policy(REFUSED.notYours)
  const sig = decoded.TxnSignature
  if (typeof sig !== 'string' || !sig) throw Err.signature()

  // Same signing hash, and the same transaction byte for byte (this also covers fields outside the signature, e.g. BatchSigners).
  const { unsignedBlob, signingHash } = signingForm(decoded, session.publicKey)
  if (signingHash !== p.signingHash || unsignedBlob !== p.unsignedBlob) throw Err.policy(REFUSED.mismatch)

  let valid = false
  try {
    const { TxnSignature: _sig, ...unsigned } = decoded
    valid = rk.verify(encodeForSigning(unsigned as never), sig, session.publicKey)
  } catch {
    valid = false
  }
  if (!valid) throw Err.signature()

  if (p.usedAt) throw Err.policy(REFUSED.used)
  if (Date.parse(p.expiresAt) <= core.now()) throw Err.policy(REFUSED.expired)
  if (p.lastLedgerSequence !== undefined && (await core.ledger.ledgerIndex()) > p.lastLedgerSequence) throw Err.policy(REFUSED.expired)
  return p
}

/** Atomically marks the PreparedTx used. False if someone else got there first. */
export function markUsed(core: Core, id: string): boolean {
  return core.db.prepare('UPDATE prepared_txs SET used_at = ? WHERE id = ? AND used_at IS NULL').run(core.iso(), id).changes === 1
}

export function recordResult(core: Core, id: string, r: { hash?: string; engineResult: string }, outcome: 'unknown' | 'final' = 'final'): void {
  core.db.prepare('UPDATE prepared_txs SET ledger_hash = ?, engine_result = ?, outcome = ? WHERE id = ?').run(r.hash || null, r.engineResult, outcome, id)
}

/** Records the final result of an 'unknown' submit. False when someone else settled it first (the caller skips the effects). */
export function settleRecorded(core: Core, id: string, r: { hash?: string; engineResult: string }): boolean {
  return (
    core.db
      .prepare("UPDATE prepared_txs SET ledger_hash = COALESCE(?, ledger_hash), engine_result = ?, outcome = 'final' WHERE id = ? AND outcome = 'unknown'")
      .run(r.hash || null, r.engineResult, id).changes === 1
  )
}

/** Submits whose answer was lost, oldest first. */
export function preparedUnknown(core: Core): PreparedRow[] {
  return (core.db.prepare("SELECT * FROM prepared_txs WHERE outcome = 'unknown' ORDER BY created_at").all() as Raw[]).map(fromRaw)
}

export const POLICY_COPY = REFUSED
