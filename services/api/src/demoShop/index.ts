// Demo shop "Sette Archi" (SPEC §4.14, §6.3): catalogue, orders paid through a normal payment request of the seeded
// shop merchant (src/seed.ts), order status from that request, and the receipt on the buyer's activity once paid.
// Public, only with DEMO_MODE=1 and the demoShop flag (enforced by mount() from the route table).
import type { Hono } from 'hono'
import type { Receipt } from '@zecca/contracts'
import type { Core } from '../core'
import { Err } from '../errors'
import { mount } from '../http'
import { emitActivity } from '../books'
import { seedDemoShop } from '../seed'
import { requests, toPaymentRequest, type RequestRow } from '../paymentRequests/repo'
import { emitRequest } from '../paymentRequests/routes'
import { catalog, priceOrder, SHOP_NAME, type ShopLine } from './catalog'

type OrderRow = { id: string; seq: number; lines: ShopLine[]; amountMinor: number; paymentRequestId: string; createdAt: string }
type Raw = { id: string; seq: number; lines_json: string; amount_minor: number; payment_request_id: string; created_at: string }

const FIRST_ORDER = 1001

function ensureTable(core: Core): void {
  // The shop's own table, outside the API's migrations (the shop is a demo module that can be dropped).
  core.db.exec(`
    CREATE TABLE IF NOT EXISTS demo_shop_orders (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      lines_json TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
      payment_request_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    )`)
}

const orders = {
  byId(core: Core, id: string): OrderRow | undefined {
    const r = core.db.prepare('SELECT * FROM demo_shop_orders WHERE id = ?').get(id) as Raw | undefined
    return r && { id: r.id, seq: r.seq, lines: JSON.parse(r.lines_json) as ShopLine[], amountMinor: r.amount_minor, paymentRequestId: r.payment_request_id, createdAt: r.created_at }
  },
  nextSeq(core: Core): number {
    return (core.db.prepare('SELECT COALESCE(MAX(seq), ?) + 1 AS n FROM demo_shop_orders').get(FIRST_ORDER - 1) as { n: number }).n
  },
  insert(core: Core, o: Omit<OrderRow, 'createdAt'>): OrderRow {
    core.db
      .prepare('INSERT INTO demo_shop_orders (id, seq, lines_json, amount_minor, payment_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(o.id, o.seq, JSON.stringify(o.lines), o.amountMinor, o.paymentRequestId, core.iso())
    return orders.byId(core, o.id)!
  },
}

const orderNumber = (o: OrderRow) => `SA-${o.seq}`

function receiptOf(o: OrderRow, pr: RequestRow): Receipt {
  return {
    orderNumber: orderNumber(o),
    shopName: SHOP_NAME,
    items: o.lines.map(({ name, qty, unitMinor }) => ({ name, qty, unitMinor })),
    amountMinor: o.amountMinor,
    method: 'zecca',
    status: 'completed',
    at: pr.paidAt!,
    reference: pr.id,
  }
}

/** Puts the receipt on the buyer's side of the paying intent, once, and pushes the row again (the app replaces it by id). */
function attachReceipt(core: Core, o: OrderRow, pr: RequestRow): void {
  if (pr.status !== 'paid' || !pr.intentId) return
  const row = core.db.prepare("SELECT id FROM activities WHERE intent_id = ? AND direction = 'out' AND receipt_json IS NULL").get(pr.intentId) as
    | { id: string }
    | undefined
  if (!row) return
  const changed = core.db.prepare('UPDATE activities SET receipt_json = ? WHERE id = ? AND receipt_json IS NULL').run(JSON.stringify(receiptOf(o, pr)), row.id).changes
  if (changed === 1) emitActivity(core, row.id)
}

/** Live: when the order's request is paid, attach the receipt right away. Reads of the order repeat it (idempotent). */
function watchOrder(core: Core, o: OrderRow): void {
  const unsub = core.bus.subscribeRequest(o.paymentRequestId, (e) => {
    if (e.type !== 'payment_request.updated') return
    if (e.data.status === 'paid') {
      const pr = requests.byId(core, o.paymentRequestId)
      if (pr) attachReceipt(core, o, pr)
    }
    if (e.data.status === 'paid' || e.data.status === 'expired' || e.data.status === 'cancelled') unsub()
  })
}

export function mountDemoShop(app: Hono, core: Core): void {
  ensureTable(core)

  mount(app, core, 'shopItems', () => catalog())

  mount(app, core, 'shopOrderCreate', async ({ body }) => {
    const { amountMinor, lines } = priceOrder(body.items)
    const merchantId = await seedDemoShop(core)
    if (!merchantId) throw Err.upstream('The demo shop is closed right now. Try again later.')
    const id = core.id('ord')
    const prId = core.id('pr')
    const o = core.db.transaction(() => {
      // The order number goes in the request's reference, so the seq is taken first.
      const seq = orders.nextSeq(core)
      requests.insert(core, {
        id: prId,
        merchantId,
        amountMinor,
        reference: `Order SA-${seq}`,
        status: 'created',
        expiresAt: core.iso(core.now() + core.settings.paymentRequestTtlMs),
      })
      return orders.insert(core, { id, seq, lines, amountMinor, paymentRequestId: prId })
    })()
    watchOrder(core, o)
    return { orderId: o.id, amountMinor, paymentRequest: toPaymentRequest(core, requests.byId(core, prId)!) }
  })

  mount(app, core, 'shopOrderGet', ({ params }) => {
    const o = orders.byId(core, params.id)
    if (!o) throw Err.notFound("We couldn't find this order.")
    // refresh() only expires a due request; unlike the public request read it never marks it opened.
    const before = requests.byId(core, o.paymentRequestId)?.status
    const pr = requests.refresh(core, o.paymentRequestId)
    // The expire job skips a row refresh() already expired, so tell the stream (and the order watcher) here.
    if (pr?.status === 'expired' && before !== 'expired') emitRequest(core, pr.id)
    const paid = pr?.status === 'paid'
    if (paid) attachReceipt(core, o, pr)
    return {
      id: o.id,
      items: o.lines,
      amountMinor: o.amountMinor,
      status: paid ? ('paid' as const) : ('pending' as const),
      ...(paid ? { method: 'zecca' as const, receipt: receiptOf(o, pr) } : {}),
      paymentRequestId: o.paymentRequestId,
      createdAt: o.createdAt,
    }
  })
}
