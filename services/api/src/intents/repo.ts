// Intent rows. State changes only through contracts' assertIntentTransition (SPEC §8).
import { IntentKind, assertIntentTransition, type Intent, type IntentStatus, type Network } from '@zecca/contracts'
import type { Core } from '../core'

/** Internal kinds: the contract's IntentKind plus our own credits (top-up, welcome credit). */
export type InternalKind = IntentKind | 'topup' | 'welcome'

/** fromUserId of credits that come from Zecca itself (top-up, welcome credit). */
export const ZECCA = 'zecca'

export type IntentRow = {
  id: string
  kind: InternalKind
  status: IntentStatus
  fromUserId: string
  toUserId?: string
  amountMinor: number
  feeMinor: number
  note?: string
  paymentRequestId?: string
  prepareId?: string
  depositTxHash?: string
  payoutTxHash?: string
  ciphertextPreview?: string
  network: Network
  failure?: { code: string; message: string }
  createdAt: string
  updatedAt: string
  submittedAt?: string
}

type Raw = {
  id: string
  kind: InternalKind
  status: IntentStatus
  from_user_id: string
  to_user_id: string | null
  amount_minor: number
  fee_minor: number
  note: string | null
  payment_request_id: string | null
  prepare_id: string | null
  deposit_tx_hash: string | null
  payout_tx_hash: string | null
  ciphertext_preview: string | null
  network: Network
  failure_code: string | null
  failure_message: string | null
  created_at: string
  updated_at: string
  submitted_at: string | null
}

const fromRaw = (r: Raw): IntentRow => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  fromUserId: r.from_user_id,
  toUserId: r.to_user_id ?? undefined,
  amountMinor: r.amount_minor,
  feeMinor: r.fee_minor,
  note: r.note ?? undefined,
  paymentRequestId: r.payment_request_id ?? undefined,
  prepareId: r.prepare_id ?? undefined,
  depositTxHash: r.deposit_tx_hash ?? undefined,
  payoutTxHash: r.payout_tx_hash ?? undefined,
  ciphertextPreview: r.ciphertext_preview ?? undefined,
  network: r.network,
  failure: r.failure_code ? { code: r.failure_code, message: r.failure_message ?? '' } : undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  submittedAt: r.submitted_at ?? undefined,
})

/** The contract's Intent. A top-up is shown as kind 'p2p' from Zecca until IntentKind has 'topup' (contract request). */
export function toIntent(i: IntentRow): Intent {
  const kind = (IntentKind.options as readonly string[]).includes(i.kind) ? (i.kind as IntentKind) : 'p2p'
  return {
    id: i.id,
    kind,
    status: i.status,
    fromUserId: i.fromUserId,
    ...(i.toUserId ? { toUserId: i.toUserId } : {}),
    amountMinor: i.amountMinor,
    feeMinor: i.feeMinor,
    ...(i.note ? { note: i.note } : {}),
    ...(i.paymentRequestId ? { paymentRequestId: i.paymentRequestId } : {}),
    ...(i.depositTxHash ? { depositTxHash: i.depositTxHash } : {}),
    ...(i.payoutTxHash ? { payoutTxHash: i.payoutTxHash } : {}),
    ...(i.failure ? { failure: i.failure } : {}),
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  }
}

type Patch = Partial<Pick<IntentRow, 'depositTxHash' | 'payoutTxHash' | 'ciphertextPreview' | 'prepareId' | 'failure' | 'submittedAt'>>

export const intents = {
  byId(core: Core, id: string): IntentRow | undefined {
    const r = core.db.prepare('SELECT * FROM intents WHERE id = ?').get(id) as Raw | undefined
    return r && fromRaw(r)
  },
  byDepositHash(core: Core, hash: string): IntentRow | undefined {
    const r = core.db.prepare('SELECT * FROM intents WHERE deposit_tx_hash = ?').get(hash) as Raw | undefined
    return r && fromRaw(r)
  },
  forRequest(core: Core, paymentRequestId: string): IntentRow[] {
    return (core.db.prepare('SELECT * FROM intents WHERE payment_request_id = ? ORDER BY created_at').all(paymentRequestId) as Raw[]).map(fromRaw)
  },
  withStatus(core: Core, status: IntentStatus): IntentRow[] {
    return (core.db.prepare('SELECT * FROM intents WHERE status = ?').all(status) as Raw[]).map(fromRaw)
  },
  insert(core: Core, i: Omit<IntentRow, 'createdAt' | 'updatedAt' | 'network'> & { network?: Network }): IntentRow {
    const at = core.iso()
    core.db
      .prepare(
        `INSERT INTO intents (id, kind, status, from_user_id, to_user_id, amount_minor, fee_minor, note, payment_request_id, prepare_id,
           deposit_tx_hash, payout_tx_hash, ciphertext_preview, network, failure_code, failure_message, created_at, updated_at, submitted_at)
         VALUES (@id, @kind, @status, @from, @to, @amount, @fee, @note, @pr, @prep, @dep, @pay, @ct, @network, @fc, @fm, @at, @at, @sub)`,
      )
      .run({
        id: i.id,
        kind: i.kind,
        status: i.status,
        from: i.fromUserId,
        to: i.toUserId ?? null,
        amount: i.amountMinor,
        fee: i.feeMinor,
        note: i.note ?? null,
        pr: i.paymentRequestId ?? null,
        prep: i.prepareId ?? null,
        dep: i.depositTxHash ?? null,
        pay: i.payoutTxHash ?? null,
        ct: i.ciphertextPreview ?? null,
        network: i.network ?? 'devnet',
        fc: i.failure?.code ?? null,
        fm: i.failure?.message ?? null,
        at,
        sub: i.submittedAt ?? null,
      })
    return intents.byId(core, i.id)!
  },
  /** Sets fields without a status change. */
  patch(core: Core, id: string, p: Patch): void {
    const sets: string[] = []
    const v: Record<string, unknown> = { id, at: core.iso() }
    const col: Record<string, string> = {
      depositTxHash: 'deposit_tx_hash',
      payoutTxHash: 'payout_tx_hash',
      ciphertextPreview: 'ciphertext_preview',
      prepareId: 'prepare_id',
      submittedAt: 'submitted_at',
    }
    for (const [k, c] of Object.entries(col)) {
      if (k in p) {
        sets.push(`${c} = @${k}`)
        v[k] = (p as Record<string, unknown>)[k] ?? null
      }
    }
    if ('failure' in p) {
      sets.push('failure_code = @fc', 'failure_message = @fm')
      v.fc = p.failure?.code ?? null
      v.fm = p.failure?.message ?? null
    }
    if (!sets.length) return
    core.db.prepare(`UPDATE intents SET ${sets.join(', ')}, updated_at = @at WHERE id = @id`).run(v)
  },
  /**
   * Moves an intent to `to` if it is currently `from` (compare-and-set). Throws InvalidTransition for a move the state machine forbids.
   * Returns false when the intent was no longer in `from` (someone else moved it: the caller skips its effect).
   */
  transition(core: Core, id: string, from: IntentStatus, to: IntentStatus, p: Patch = {}): boolean {
    assertIntentTransition(from, to)
    const changed = core.db.prepare('UPDATE intents SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(to, core.iso(), id, from).changes === 1
    if (changed) intents.patch(core, id, p)
    return changed
  },
}
