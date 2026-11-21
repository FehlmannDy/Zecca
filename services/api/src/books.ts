// Our own books (SPEC §4.3): balances per user, activity rows per side of an intent, idempotency keys for effects.
import type { Activity, Balance, Receipt } from '@zecca/contracts'
import { activityStatusOf, TxHash } from '@zecca/contracts'
import type { Core } from './core'
import { cardCtx } from './connectors/card/context'
import { intents, type IntentRow } from './intents/repo'
import { toProfile, users } from './users'

// ---------- effects (idempotency) ----------
/** Returns true the first time a key is claimed, false afterwards. Call inside the transaction that applies the effect. */
export function claimEffect(core: Core, key: string): boolean {
  return core.db.prepare('INSERT OR IGNORE INTO effects (key, created_at) VALUES (?, ?)').run(key, core.iso()).changes === 1
}

// ---------- balances ----------
type BalRaw = { available_minor: number; pending_minor: number; updated_at: string }

export function getBalance(core: Core, userId: string): Balance {
  const r = core.db.prepare('SELECT available_minor, pending_minor, updated_at FROM balances WHERE user_id = ?').get(userId) as BalRaw | undefined
  return r
    ? { availableMinor: r.available_minor, pendingMinor: r.pending_minor, updatedAt: r.updated_at }
    : { availableMinor: 0, pendingMinor: 0, updatedAt: core.iso() }
}

/** Adds signed deltas. A result below zero violates the schema's CHECK and throws (the caller's transaction rolls back). */
export function adjustBalance(core: Core, userId: string, delta: { available?: number; pending?: number }): void {
  const a = delta.available ?? 0
  const p = delta.pending ?? 0
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(p)) throw new TypeError('balance deltas must be integers')
  const t = core.iso()
  const updated = core.db
    .prepare('UPDATE balances SET available_minor = available_minor + ?, pending_minor = pending_minor + ?, updated_at = ? WHERE user_id = ?')
    .run(a, p, t, userId).changes
  if (updated === 0) core.db.prepare('INSERT INTO balances (user_id, available_minor, pending_minor, updated_at) VALUES (?, ?, ?, ?)').run(userId, a, p, t)
}

export function emitBalance(core: Core, userId: string): void {
  core.bus.toUser(userId, { type: 'balance.updated', data: getBalance(core, userId), at: core.iso() })
}

// ---------- activity ----------
export type ActivityRow = {
  id: string
  seq: number
  userId: string
  intentId: string
  direction: 'in' | 'out'
  kind: string
  counterpartyUserId?: string
  amountMinor: number
  feeMinor: number
  note?: string
  receipt?: Receipt
  createdAt: string
}

type ActRaw = {
  id: string
  seq: number
  user_id: string
  intent_id: string
  direction: 'in' | 'out'
  kind: string
  counterparty_user_id: string | null
  amount_minor: number
  fee_minor: number
  note: string | null
  receipt_json: string | null
  created_at: string
}
const actFromRaw = (r: ActRaw): ActivityRow => ({
  id: r.id,
  seq: r.seq,
  userId: r.user_id,
  intentId: r.intent_id,
  direction: r.direction,
  kind: r.kind,
  counterpartyUserId: r.counterparty_user_id ?? undefined,
  amountMinor: r.amount_minor,
  feeMinor: r.fee_minor,
  note: r.note ?? undefined,
  receipt: r.receipt_json ? (JSON.parse(r.receipt_json) as Receipt) : undefined,
  createdAt: r.created_at,
})

/** One activity row per (user, intent, direction). Returns the row id, or undefined when it already existed. */
export function addActivity(
  core: Core,
  a: Omit<ActivityRow, 'id' | 'seq' | 'createdAt'>,
): string | undefined {
  const id = core.id('act')
  const res = core.db
    .prepare(
      `INSERT OR IGNORE INTO activities (id, seq, user_id, intent_id, direction, kind, counterparty_user_id, amount_minor, fee_minor, note, receipt_json, created_at)
       VALUES (@id, (SELECT COALESCE(MAX(seq), 0) + 1 FROM activities), @userId, @intentId, @direction, @kind, @cp, @amountMinor, @feeMinor, @note, @receipt, @at)`,
    )
    .run({
      id,
      userId: a.userId,
      intentId: a.intentId,
      direction: a.direction,
      kind: a.kind,
      cp: a.counterpartyUserId ?? null,
      amountMinor: a.amountMinor,
      feeMinor: a.feeMinor,
      note: a.note ?? null,
      receipt: a.receipt ? JSON.stringify(a.receipt) : null,
      at: core.iso(),
    })
  return res.changes === 1 ? id : undefined
}

export function activityById(core: Core, id: string): ActivityRow | undefined {
  const r = core.db.prepare('SELECT * FROM activities WHERE id = ?').get(id) as ActRaw | undefined
  return r && actFromRaw(r)
}

export function activitiesOf(core: Core, userId: string, opts: { beforeSeq?: number; limit: number }): ActivityRow[] {
  const rows = core.db
    .prepare('SELECT * FROM activities WHERE user_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?')
    .all(userId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, opts.limit) as ActRaw[]
  return rows.map(actFromRaw)
}

export function activitiesOfIntent(core: Core, intentId: string): ActivityRow[] {
  return (core.db.prepare('SELECT * FROM activities WHERE intent_id = ?').all(intentId) as ActRaw[]).map(actFromRaw)
}

/** The Activity shape for one side (SPEC §5): status from the intent, ledger hashes + network, counterparty profile. */
export function toActivity(core: Core, a: ActivityRow, intent?: IntentRow): Activity {
  if (a.kind === 'card_purchase') return cardPurchaseActivity(core, a)
  const i = intent ?? intents.byId(core, a.intentId)
  const cp = a.counterpartyUserId ? users.byId(core, a.counterpartyUserId) : undefined
  return {
    id: a.id,
    intentId: a.intentId,
    direction: a.direction,
    kind: a.kind as Activity['kind'],
    ...(cp ? { counterparty: toProfile(cp) } : {}),
    amountMinor: a.amountMinor,
    feeMinor: a.feeMinor,
    status: i ? activityStatusOf(i.status) : 'pending',
    ...(a.note ? { note: a.note } : {}),
    at: a.createdAt,
    ledger: {
      ...(i?.depositTxHash ? { depositTxHash: i.depositTxHash } : {}),
      ...(i?.payoutTxHash ? { payoutTxHash: i.payoutTxHash } : {}),
      network: i?.network ?? 'devnet',
      // Top-ups are paid out of the pool on Devnet, whatever network delivered them.
      ...(a.kind === 'topup' ? { payoutNetwork: 'devnet' as const } : {}),
      ...(i?.ciphertextPreview ? { ciphertextPreview: i.ciphertextPreview } : {}),
    },
    ...(a.receipt ? { receipt: a.receipt } : {}),
  }
}

// ---------- card purchases ----------
// A card purchase is not an intent: it lives in the card connector's sub-ledger (one hold per Lithic authorization). Its
// activity row (intentId = the authorization id) gives it a place in the list; status, amount and receipt are read from
// the hold each time, so they follow it (authorised -> completed, declined, voided).

const CARD_COPY = { voided: 'Cancelled by the shop. The money is back on your card.' } as const

function cardPurchaseActivity(core: Core, a: ActivityRow): Activity {
  const store = cardCtx(core).store
  const h = store.hold(a.intentId)
  const base: Activity = { id: a.id, intentId: a.intentId, direction: a.direction, kind: 'card_purchase', amountMinor: a.amountMinor, feeMinor: 0, status: 'pending', at: a.createdAt, ledger: { network: 'devnet' } }
  if (!h) return base
  const status: Activity['status'] = h.status === 'completed' || h.status === 'refunded' ? 'done' : h.status === 'authorised' ? 'pending' : 'failed'
  const note = h.status === 'refunded' ? `Refund from ${h.merchant}` : h.status === 'declined' ? h.declineReason : h.status === 'voided' ? CARD_COPY.voided : undefined
  const receiptStatus = h.status === 'completed' ? 'completed' : h.status === 'authorised' ? 'authorised' : h.status === 'declined' ? 'declined' : undefined
  let receipt: Receipt | undefined
  if (receiptStatus && h.amountMinor > 0) {
    const shop = store.chargeByAuth(h.authToken)?.receipt
    const last4 = store.cardByToken(h.cardToken)?.last4
    receipt = shop
      ? { ...shop, amountMinor: h.amountMinor, status: receiptStatus }
      : { orderNumber: h.authToken.slice(0, 8).toUpperCase(), shopName: h.merchant, items: [], amountMinor: h.amountMinor, method: 'card', ...(last4 ? { cardLast4: last4 } : {}), status: receiptStatus, at: h.createdAt, reference: h.authToken }
  }
  const settled = h.settleTx && TxHash.safeParse(h.settleTx).success ? h.settleTx : undefined
  return {
    ...base,
    amountMinor: h.amountMinor,
    status,
    ...(note ? { note } : {}),
    at: h.createdAt,
    ledger: { network: 'devnet', ...(settled ? { payoutTxHash: settled } : {}) },
    ...(receipt ? { receipt } : {}),
  }
}

function cardActivityRow(core: Core, userId: string, authToken: string): string | undefined {
  const h = cardCtx(core).store.hold(authToken)
  if (!h || h.userId !== userId) return undefined
  const direction = h.status === 'refunded' ? 'in' : 'out'
  return (
    addActivity(core, { userId, intentId: h.authToken, direction, kind: 'card_purchase', amountMinor: h.amountMinor, feeMinor: 0 }) ??
    activitiesOfIntent(core, h.authToken).find((x) => x.userId === userId && x.direction === direction)?.id
  )
}

/** A card.authorization went to the cardholder: keep their activity row and push it again (the app replaces it by id). Never throws. */
export function recordCardActivity(core: Core, userId: string, authToken: string): void {
  try {
    emitActivity(core, cardActivityRow(core, userId, authToken))
  } catch (e) {
    core.log.error(`[books] card activity for ${authToken}: ${(e as Error).message}`)
  }
}

/** Rows for card purchases recorded without one (before this existed, or a missed event). Card feature on only. */
export function backfillCardActivity(core: Core, userId: string): void {
  if (!core.settings.features.card) return
  const store = cardCtx(core).store
  for (const h of store.holdsOf(userId, 200).reverse()) {
    if (!activitiesOfIntent(core, h.authToken).some((x) => x.userId === userId)) cardActivityRow(core, userId, h.authToken)
  }
}

export function emitActivity(core: Core, activityId: string | undefined): void {
  if (!activityId) return
  const a = activityById(core, activityId)
  if (a) core.bus.toUser(a.userId, { type: 'activity.created', data: toActivity(core, a), at: core.iso() })
}
