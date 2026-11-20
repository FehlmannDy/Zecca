// Payment request rows and their state machine (SPEC §8).
import { assertPaymentRequestTransition, type PaymentRequest, type PaymentRequestStatus } from '@zecca/contracts'
import type { Core } from '../core'
import { Err } from '../errors'
import { users } from '../users'

export type RequestRow = {
  id: string
  merchantId: string
  amountMinor: number
  reference?: string
  status: PaymentRequestStatus
  expiresAt: string
  paidAt?: string
  intentId?: string
  claimedIntentId?: string
  createdAt: string
}

type Raw = {
  id: string
  merchant_id: string
  amount_minor: number
  reference: string | null
  status: PaymentRequestStatus
  expires_at: string
  paid_at: string | null
  intent_id: string | null
  claimed_intent_id: string | null
  created_at: string
}
const fromRaw = (r: Raw): RequestRow => ({
  id: r.id,
  merchantId: r.merchant_id,
  amountMinor: r.amount_minor,
  reference: r.reference ?? undefined,
  status: r.status,
  expiresAt: r.expires_at,
  paidAt: r.paid_at ?? undefined,
  intentId: r.intent_id ?? undefined,
  claimedIntentId: r.claimed_intent_id ?? undefined,
  createdAt: r.created_at,
})

export const requests = {
  byId(core: Core, id: string): RequestRow | undefined {
    const r = core.db.prepare('SELECT * FROM payment_requests WHERE id = ?').get(id) as Raw | undefined
    return r && fromRaw(r)
  },
  insert(core: Core, r: Omit<RequestRow, 'createdAt'>): RequestRow {
    const at = core.iso()
    core.db
      .prepare(
        `INSERT INTO payment_requests (id, merchant_id, amount_minor, reference, status, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.merchantId, r.amountMinor, r.reference ?? null, r.status, r.expiresAt, at, at)
    return requests.byId(core, r.id)!
  },
  /** Compare-and-set status change through the state machine. */
  transition(core: Core, id: string, from: PaymentRequestStatus, to: PaymentRequestStatus, extra: { paidAt?: string; intentId?: string } = {}): boolean {
    assertPaymentRequestTransition(from, to)
    return (
      core.db
        .prepare(
          `UPDATE payment_requests SET status = @to, updated_at = @at, paid_at = COALESCE(@paidAt, paid_at), intent_id = COALESCE(@intentId, intent_id)
           WHERE id = @id AND status = @from`,
        )
        .run({ id, from, to, at: core.iso(), paidAt: extra.paidAt ?? null, intentId: extra.intentId ?? null }).changes === 1
    )
  },
  /** Expires the request if its time is up. Returns the fresh row. */
  refresh(core: Core, id: string): RequestRow | undefined {
    const r = requests.byId(core, id)
    if (r && (r.status === 'created' || r.status === 'opened') && Date.parse(r.expiresAt) <= core.now() && !r.claimedIntentId) {
      if (requests.transition(core, id, r.status, 'expired')) return { ...r, status: 'expired' }
    }
    return r
  },
}

export function toPaymentRequest(core: Core, r: RequestRow): PaymentRequest {
  const m = users.byId(core, r.merchantId)
  return {
    id: r.id,
    merchantId: r.merchantId,
    merchantName: m?.businessName ?? m?.displayName ?? 'Merchant',
    amountMinor: r.amountMinor,
    ...(r.reference ? { reference: r.reference } : {}),
    status: r.status,
    url: `${core.settings.webOrigin}/pay/${encodeURIComponent(r.id)}`,
    expiresAt: r.expiresAt,
    ...(r.paidAt ? { paidAt: r.paidAt } : {}),
    ...(r.intentId ? { intentId: r.intentId } : {}),
  }
}

/** Refuses a request that cannot be paid any more, with the pay page's copy. */
export function assertPayable(core: Core, r: RequestRow, intentId?: string): void {
  if (r.status === 'paid') throw Err.alreadyPaid()
  if (r.status === 'cancelled') throw Err.expired('This request was cancelled. Ask the merchant for a new one.')
  if (r.status === 'expired') throw Err.expired()
  if (r.claimedIntentId && r.claimedIntentId !== intentId) throw Err.alreadyPaid()
  if (Date.parse(r.expiresAt) <= core.now()) throw Err.expired()
}

/** At submit: only one intent can pay a request (SPEC §8). Throws 409 when another one holds it. */
export function claimRequest(core: Core, id: string, intentId: string): void {
  const r = requests.byId(core, id)
  if (!r) throw Err.notFound('This request no longer exists.')
  assertPayable(core, r, intentId)
  const ok =
    core.db
      .prepare(
        `UPDATE payment_requests SET claimed_intent_id = @i, updated_at = @at
         WHERE id = @id AND status IN ('created', 'opened') AND (claimed_intent_id IS NULL OR claimed_intent_id = @i)`,
      )
      .run({ id, i: intentId, at: core.iso() }).changes === 1
  if (!ok) throw Err.alreadyPaid()
}

export function releaseRequest(core: Core, id: string, intentId: string): void {
  core.db.prepare('UPDATE payment_requests SET claimed_intent_id = NULL WHERE id = ? AND claimed_intent_id = ?').run(id, intentId)
}

/** On the intent's 'received' (D4): the request is paid. Returns true when it changed. */
export function markRequestPaid(core: Core, id: string, intentId: string): boolean {
  const r = requests.byId(core, id)
  if (!r || (r.status !== 'created' && r.status !== 'opened')) return false
  return requests.transition(core, id, r.status, 'paid', { paidAt: core.iso(), intentId })
}
