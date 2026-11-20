// The market's own tables (created here, not in the shared migrations): orders, and who holds which metal.
import type { MetalSymbol } from '@zecca/contracts'
import type { Core } from '../../core'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS market_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL CHECK (symbol IN ('XAU', 'XAG', 'XPD')),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity_mg INTEGER NOT NULL CHECK (typeof(quantity_mg) = 'integer' AND quantity_mg > 0),
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  unit_price_minor INTEGER NOT NULL CHECK (typeof(unit_price_minor) = 'integer' AND unit_price_minor > 0),
  spread_minor INTEGER NOT NULL CHECK (typeof(spread_minor) = 'integer' AND spread_minor >= 0),
  feed_price_minor INTEGER NOT NULL,
  price_at TEXT NOT NULL,
  price_source TEXT NOT NULL,
  intent_id TEXT UNIQUE,
  prepare_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('authorize', 'authorized', 'open', 'delivering', 'done', 'failed')),
  ledger_tx_hash TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  delivery_hash TEXT,
  delivery_lls INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_orders_prepare ON market_orders (prepare_id);
CREATE TABLE IF NOT EXISTS market_holders (
  user_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  tx_hash TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, symbol)
);`

export function initMarketTables(core: Core): void {
  core.db.exec(SCHEMA)
  // Tables made before the delivery look-up columns existed.
  const cols = new Set((core.db.prepare('PRAGMA table_info(market_orders)').all() as { name: string }[]).map((c) => c.name))
  for (const [name, type] of [['delivery_hash', 'TEXT'], ['delivery_lls', 'INTEGER']]) {
    if (!cols.has(name)) core.db.exec(`ALTER TABLE market_orders ADD COLUMN ${name} ${type}`)
  }
}

export type OrderStatus = 'authorize' | 'authorized' | 'open' | 'delivering' | 'done' | 'failed'
export type OrderRow = {
  id: string
  userId: string
  symbol: MetalSymbol
  side: 'buy' | 'sell'
  quantityMg: number
  amountMinor: number
  unitPriceMinor: number
  spreadMinor: number
  feedPriceMinor: number
  priceAt: string
  priceSource: string
  intentId?: string
  prepareId?: string
  status: OrderStatus
  ledgerTxHash?: string
  attempts: number
  /** The delivery in flight (buy): its hash when the ledger answered, and its LastLedgerSequence (set before the submit). */
  deliveryHash?: string
  deliveryLls?: number
  createdAt: string
}

type Raw = {
  id: string
  user_id: string
  symbol: MetalSymbol
  side: 'buy' | 'sell'
  quantity_mg: number
  amount_minor: number
  unit_price_minor: number
  spread_minor: number
  feed_price_minor: number
  price_at: string
  price_source: string
  intent_id: string | null
  prepare_id: string | null
  status: OrderStatus
  ledger_tx_hash: string | null
  attempts: number
  delivery_hash: string | null
  delivery_lls: number | null
  created_at: string
}

const fromRaw = (r: Raw | undefined): OrderRow | undefined =>
  r && {
    id: r.id,
    userId: r.user_id,
    symbol: r.symbol,
    side: r.side,
    quantityMg: r.quantity_mg,
    amountMinor: r.amount_minor,
    unitPriceMinor: r.unit_price_minor,
    spreadMinor: r.spread_minor,
    feedPriceMinor: r.feed_price_minor,
    priceAt: r.price_at,
    priceSource: r.price_source,
    intentId: r.intent_id ?? undefined,
    prepareId: r.prepare_id ?? undefined,
    status: r.status,
    ledgerTxHash: r.ledger_tx_hash ?? undefined,
    attempts: r.attempts,
    deliveryHash: r.delivery_hash ?? undefined,
    deliveryLls: r.delivery_lls ?? undefined,
    createdAt: r.created_at,
  }

export const orders = {
  insert(core: Core, o: Omit<OrderRow, 'createdAt' | 'attempts' | 'deliveryHash' | 'deliveryLls'>): void {
    const at = core.iso()
    core.db
      .prepare(
        `INSERT INTO market_orders (id, user_id, symbol, side, quantity_mg, amount_minor, unit_price_minor, spread_minor, feed_price_minor,
           price_at, price_source, intent_id, prepare_id, status, ledger_tx_hash, created_at, updated_at)
         VALUES (@id, @userId, @symbol, @side, @quantityMg, @amountMinor, @unitPriceMinor, @spreadMinor, @feedPriceMinor,
           @priceAt, @priceSource, @intentId, @prepareId, @status, @ledgerTxHash, @at, @at)`,
      )
      .run({ ...o, intentId: o.intentId ?? null, prepareId: o.prepareId ?? null, ledgerTxHash: o.ledgerTxHash ?? null, at })
  },
  byId: (core: Core, id: string) => fromRaw(core.db.prepare('SELECT * FROM market_orders WHERE id = ?').get(id) as Raw | undefined),
  byIntent: (core: Core, intentId: string) => fromRaw(core.db.prepare('SELECT * FROM market_orders WHERE intent_id = ?').get(intentId) as Raw | undefined),
  byPrepare: (core: Core, prepareId: string) => fromRaw(core.db.prepare('SELECT * FROM market_orders WHERE prepare_id = ?').get(prepareId) as Raw | undefined),
  withStatus: (core: Core, status: OrderStatus) => (core.db.prepare('SELECT * FROM market_orders WHERE status = ?').all(status) as Raw[]).map((r) => fromRaw(r)!),
  setPrepare(core: Core, id: string, prepareId: string): void {
    core.db.prepare('UPDATE market_orders SET prepare_id = ?, updated_at = ? WHERE id = ?').run(prepareId, core.iso(), id)
  },
  /**
   * A delivery attempt starts, before anything is sent: status -> delivering, attempts + 1, the attempt's LastLedgerSequence,
   * no hash yet. One statement, so a restart always knows what to look for. Compare-and-set on `from`.
   */
  claimDelivery(core: Core, id: string, from: OrderStatus, lastLedgerSequence: number): boolean {
    return (
      core.db
        .prepare(
          `UPDATE market_orders SET status = 'delivering', attempts = attempts + 1, delivery_lls = ?, delivery_hash = NULL, updated_at = ?
           WHERE id = ? AND status = ?`,
        )
        .run(lastLedgerSequence, core.iso(), id, from).changes === 1
    )
  },
  setDeliveryHash(core: Core, id: string, hash: string): void {
    core.db.prepare('UPDATE market_orders SET delivery_hash = ?, updated_at = ? WHERE id = ?').run(hash, core.iso(), id)
  },
  /** Compare-and-set on the status. False when the order was not in `from` (someone else moved it). */
  move(core: Core, id: string, from: OrderStatus, to: OrderStatus, p: { ledgerTxHash?: string } = {}): boolean {
    return (
      core.db
        .prepare('UPDATE market_orders SET status = ?, ledger_tx_hash = COALESCE(?, ledger_tx_hash), updated_at = ? WHERE id = ? AND status = ?')
        .run(to, p.ledgerTxHash ?? null, core.iso(), id, from).changes === 1
    )
  },
}

export const holders = {
  has: (core: Core, userId: string, symbol: MetalSymbol) =>
    core.db.prepare('SELECT 1 FROM market_holders WHERE user_id = ? AND symbol = ?').get(userId, symbol) !== undefined,
  add(core: Core, userId: string, symbol: MetalSymbol, txHash?: string): void {
    core.db.prepare('INSERT OR IGNORE INTO market_holders (user_id, symbol, tx_hash, created_at) VALUES (?, ?, ?, ?)').run(userId, symbol, txHash ?? null, core.iso())
  },
}
