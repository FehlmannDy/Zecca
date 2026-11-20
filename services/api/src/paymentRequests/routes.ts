// Payment requests (SPEC §8), the merchant's sales and their CSV export.
import type { Hono } from 'hono'
import { feeMinor, formatUsd, type Sale } from '@zecca/contracts'
import type { Core } from '../core'
import { Err } from '../errors'
import { mount } from '../http'
import { sse } from '../events'
import { toProfile, users } from '../users'
import { intents } from '../intents/repo'
import { createSendIntent, onRequestPaid } from '../intents/flow'
import { assertPayable, requests, toPaymentRequest, type RequestRow } from './repo'

export function emitRequest(core: Core, id: string): void {
  const r = requests.byId(core, id)
  if (!r) return
  const e = { type: 'payment_request.updated' as const, data: toPaymentRequest(core, r), at: core.iso() }
  core.bus.toUser(r.merchantId, e)
  core.bus.toRequest(r.id, e)
}

/** Expires due requests (background job and lazy reads). */
export function expireRequests(core: Core): number {
  const due = core.db
    .prepare("SELECT id FROM payment_requests WHERE status IN ('created', 'opened') AND expires_at <= ? AND claimed_intent_id IS NULL")
    .all(core.iso()) as Array<{ id: string }>
  let n = 0
  for (const { id } of due) {
    const before = requests.byId(core, id)!.status
    if (requests.refresh(core, id)?.status === 'expired' && before !== 'expired') {
      emitRequest(core, id)
      n++
    }
  }
  return n
}

function salesOf(core: Core, merchantId: string, from?: string, to?: string): { items: Sale[]; totals: { grossMinor: number; feeMinor: number; netMinor: number; count: number } } {
  const rows = core.db
    .prepare(
      `SELECT id FROM payment_requests WHERE merchant_id = ? AND status = 'paid' AND paid_at >= ? AND paid_at <= ? ORDER BY paid_at DESC, id DESC`,
    )
    .all(merchantId, from ?? '0000', to ?? '9999') as Array<{ id: string }>
  const items: Sale[] = []
  for (const { id } of rows) {
    const r = requests.byId(core, id) as RequestRow
    const i = r.intentId ? intents.byId(core, r.intentId) : undefined
    if (!i) continue
    const payer = users.byId(core, i.fromUserId)
    items.push({
      id: `sale_${r.id}`,
      paymentRequestId: r.id,
      amountMinor: i.amountMinor,
      feeMinor: i.feeMinor,
      netMinor: i.amountMinor - i.feeMinor,
      ...(payer ? { payer: toProfile(payer) } : {}),
      ...(r.reference ? { reference: r.reference } : {}),
      paidAt: r.paidAt!,
      payoutStatus: i.status === 'paid_out' ? 'done' : 'pending',
    })
  }
  const totals = items.reduce(
    (t, s) => ({ grossMinor: t.grossMinor + s.amountMinor, feeMinor: t.feeMinor + s.feeMinor, netMinor: t.netMinor + s.netMinor, count: t.count + 1 }),
    { grossMinor: 0, feeMinor: 0, netMinor: 0, count: 0 },
  )
  return { items, totals }
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

export function salesCsv(sales: Sale[]): string {
  const head = ['Date (UTC)', 'Reference', 'Customer', 'Amount', 'Fee', 'Net', 'Payout']
  const lines = sales.map((s) =>
    [
      s.paidAt,
      s.reference ?? '',
      s.payer ? `${s.payer.displayName} (@${s.payer.handle})` : 'Customer',
      formatUsd(s.amountMinor),
      formatUsd(s.feeMinor),
      formatUsd(s.netMinor),
      s.payoutStatus === 'done' ? 'Paid out' : 'Paying out',
    ]
      .map(csvCell)
      .join(','),
  )
  return [head.join(','), ...lines].join('\r\n') + '\r\n'
}

export function mountPaymentRequests(app: Hono, core: Core): void {
  onRequestPaid(emitRequest)

  mount(app, core, 'paymentRequestCreate', ({ user, body }) => {
    const id = core.id('pr')
    const r = requests.insert(core, {
      id,
      merchantId: user!.id,
      amountMinor: body.amountMinor,
      reference: body.reference?.trim() || undefined,
      status: 'created',
      expiresAt: core.iso(core.now() + core.settings.paymentRequestTtlMs),
    })
    return toPaymentRequest(core, r)
  })

  mount(app, core, 'paymentRequestGet', ({ params, user }) => {
    let r = requests.refresh(core, params.id)
    if (!r) throw Err.notFound("We couldn't find this request.")
    // The first read by someone other than the merchant: the customer has the page open.
    if (r.status === 'created' && user?.id !== r.merchantId && requests.transition(core, r.id, 'created', 'opened')) {
      r = requests.byId(core, r.id)!
      emitRequest(core, r.id)
    }
    return toPaymentRequest(core, r)
  })

  mount(app, core, 'paymentRequestEvents', ({ c, params }) => {
    const r = requests.refresh(core, params.id)
    if (!r) throw Err.notFound("We couldn't find this request.")
    return sse(c, core, (l) => core.bus.subscribeRequest(r.id, l), [{ type: 'payment_request.updated', data: toPaymentRequest(core, r), at: core.iso() }])
  })

  mount(app, core, 'paymentRequestPay', async ({ params, user }) => {
    const r = requests.refresh(core, params.id)
    if (!r) throw Err.notFound("We couldn't find this request.")
    if (r.merchantId === user!.id) throw Err.badRequest("You can't pay your own request.")
    if (r.claimedIntentId) {
      const holder = intents.byId(core, r.claimedIntentId)
      if (holder && holder.status !== 'failed' && holder.status !== 'expired') throw Err.alreadyPaid()
    }
    assertPayable(core, { ...r, claimedIntentId: undefined })
    const merchant = users.byId(core, r.merchantId)
    if (!merchant || merchant.status !== 'active') throw Err.notFound("We couldn't find this merchant.")
    const fee = feeMinor(r.amountMinor, merchant.feeBps ?? core.settings.merchantFeeBps)
    return createSendIntent(core, { sender: user!, recipient: merchant, kind: 'merchant', amountMinor: r.amountMinor, feeMinor: fee, note: r.reference, paymentRequestId: r.id })
  })

  mount(app, core, 'paymentRequestCancel', ({ params, user }) => {
    const r = requests.refresh(core, params.id)
    if (!r || r.merchantId !== user!.id) throw Err.notFound("We couldn't find this request.")
    if (r.status === 'cancelled') return toPaymentRequest(core, r)
    if (r.status !== 'created' && r.status !== 'opened') throw Err.conflict(r.status === 'paid' ? 'This request has already been paid.' : 'This request has expired.')
    if (r.claimedIntentId) throw Err.conflict('The customer is paying right now.')
    requests.transition(core, r.id, r.status, 'cancelled')
    emitRequest(core, r.id)
    return toPaymentRequest(core, requests.byId(core, r.id)!)
  })

  mount(app, core, 'sales', ({ user, query }) => salesOf(core, user!.id, query.from, query.to))

  mount(app, core, 'salesCsv', ({ c, user, query }) => {
    const { items } = salesOf(core, user!.id, query.from, query.to)
    return c.body(salesCsv(items), 200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="zecca-sales.csv"',
    })
  })
}
