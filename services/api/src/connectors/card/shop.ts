// "Pay by card" in the demo shop (SPEC §4.14): POST /v1/demo/shop/charge { orderId, pan, expMonth, expYear, cvc }.
// The order is read (read-only) from the demo shop's own table. The card details are checked against the Zecca card on
// Lithic, then Lithic simulates the purchase as the shop would make it: our ASA webhook decides it from the card balance.
// The decision is read from the transaction (simulate answers 201 even on a decline), then the purchase is cleared.
import type { Receipt } from '@zecca/contracts'
import type { Core } from '../../core'
import { ApiErr, Err } from '../../errors'
import { emitAuthorization, needLithic, sameSecret, viaLithic, type CardCtx } from './context'
import { waitForResult, type LithicApi } from './lithic-api'
import type { CardRow } from './store'

export const SHOP_NAME = 'Sette Archi'
export const SHOP_DESCRIPTOR = 'SETTE ARCHI'
/** Restaurants / coffee shops; the demo shop is a coffee roaster. */
export const SHOP_MCC = '5812'
export const DECLINED = 'Card declined. Try another payment method.'

type ShopOrder = { id: string; seq: number; lines: Array<{ name: string; qty: number; unitMinor: number }>; amountMinor: number; paymentRequestId?: string }

/** Reads an order from the demo shop's table (owned by the demo shop module; read only here). */
export function shopOrder(core: Core, orderId: string): ShopOrder | undefined {
  const has = core.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'demo_shop_orders'").get()
  if (!has) return undefined
  const r = core.db.prepare('SELECT id, seq, lines_json, amount_minor, payment_request_id FROM demo_shop_orders WHERE id = ?').get(orderId) as
    | { id: string; seq: number; lines_json: string; amount_minor: number; payment_request_id: string | null }
    | undefined
  if (!r) return undefined
  const lines = (JSON.parse(r.lines_json) as Array<{ name: string; qty: number; unitMinor: number }>).map(({ name, qty, unitMinor }) => ({ name, qty, unitMinor }))
  return { id: r.id, seq: r.seq, lines, amountMinor: r.amount_minor, paymentRequestId: r.payment_request_id ?? undefined }
}

const paidWithZecca = (core: Core, paymentRequestId?: string) =>
  !!paymentRequestId && (core.db.prepare('SELECT status FROM payment_requests WHERE id = ?').get(paymentRequestId) as { status: string } | undefined)?.status === 'paid'

const fullYear = (y: number) => (y >= 0 && y < 100 ? 2000 + y : y)

/** The Zecca card these details belong to, checked against Lithic (number and code are never stored by Zecca). */
async function matchCard(core: Core, lithic: LithicApi, ctx: CardCtx, b: { pan: string; expMonth: number; expYear: number; cvc: string }): Promise<CardRow | undefined> {
  const year = fullYear(b.expYear)
  const candidates = ctx.store.cardsByLast4(b.pan.slice(-4)).filter((c) => c.expMonth === b.expMonth && c.expYear === year && c.state !== 'CLOSED')
  for (const c of candidates) {
    const s = await viaLithic(core, 'read card for a shop charge', () => lithic.getCard(c.token))
    if (sameSecret(s.pan, b.pan) && sameSecret(s.cvv, b.cvc)) return c
  }
  return undefined
}

export async function shopCharge(
  core: Core,
  ctx: CardCtx,
  b: { orderId: string; pan: string; expMonth: number; expYear: number; cvc: string },
): Promise<{ approved: boolean; receipt?: Receipt; message?: string }> {
  const order = shopOrder(core, b.orderId)
  if (!order) throw Err.notFound("We couldn't find this order.")
  if (ctx.store.charge(order.id) || paidWithZecca(core, order.paymentRequestId)) throw new ApiErr(409, 'already_paid', 'This order has already been paid.')
  const lithic = needLithic(ctx)
  core.rateLimit(`card-charge:${b.pan.slice(-4)}`)
  if (ctx.charging.has(order.id)) throw Err.conflict('This order is being paid. Wait a moment.')
  ctx.charging.add(order.id)
  try {
    const card = await matchCard(core, lithic, ctx, b)
    if (!card) {
      core.log.info(`[card] shop charge for order ${order.id}: card details do not match a Zecca card`)
      return { approved: false, message: DECLINED }
    }
    const { token } = await viaLithic(core, 'simulate a shop purchase', () =>
      ctx.gate.run(() => lithic.simulateAuthorize({ amount: order.amountMinor, descriptor: SHOP_DESCRIPTOR, pan: b.pan, mcc: SHOP_MCC })),
    )
    ctx.store.annotate(token, { orderId: order.id })
    const tx = await viaLithic(core, 'read the shop purchase decision', () => waitForResult(lithic, token))
    const hold = ctx.store.hold(token)
    if (tx.result !== 'APPROVED') return { approved: false, message: DECLINED }
    if (!hold || hold.status === 'declined') {
      // Approved without our webhook deciding it (another ASA endpoint, or none): the card balance was not checked. Undo it.
      core.log.error(`[card] shop purchase ${token} approved by Lithic but not by our webhook; voiding it`)
      core.track(ctx.gate.run(() => lithic.simulateVoid({ token })), 'card void (undecided purchase)')
      return { approved: false, message: DECLINED }
    }
    const receipt: Receipt = {
      orderNumber: `SA-${order.seq}`,
      shopName: SHOP_NAME,
      items: order.lines,
      amountMinor: order.amountMinor,
      method: 'card',
      cardLast4: card.last4,
      status: 'authorised',
      at: core.iso(),
      reference: token,
    }
    ctx.store.saveCharge(order.id, token, receipt)
    core.track(clear(core, ctx, lithic, token, order.id), 'card clearing')
    return { approved: true, receipt }
  } finally {
    ctx.charging.delete(order.id)
  }
}

/** Settles a sandbox purchase at Lithic (POST /v1/simulate/clearing) and marks it "Completed". */
export async function clear(core: Core, ctx: CardCtx, lithic: LithicApi, token: string, orderId?: string): Promise<void> {
  try {
    await ctx.gate.run(() => lithic.simulateClearing({ token }))
  } catch (e) {
    return core.log.warn(`[card] clearing ${token} failed: ${(e as Error).message} (the poller picks it up if Lithic settles it)`)
  }
  if (ctx.store.complete(token)) emitAuthorization(core, ctx.store.hold(token))
  if (orderId) ctx.store.setChargeStatus(orderId, 'completed')
}
