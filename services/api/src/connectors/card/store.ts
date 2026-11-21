// The card sub-ledger, in integer cents, on the API's database (port of card-issuer/src/store.js, pool mode).
// The card balance is what the user moved to the card (card_load deposits to the pool), minus approved purchases,
// plus voids and refunds. A purchase is answered and spent here only; the ledger is touched after the answer.
// A refund also stores its way back on the ledger (card settlement account -> pool, returns.ts) in the same transaction.
// better-sqlite3 is synchronous and each method runs in one transaction: no two authorizations can spend the same cents.
import type { CardAuthorization, Receipt } from '@zecca/contracts'
import type { Db } from '../../db'

export type CardState = 'OPEN' | 'PAUSED' | 'CLOSED'
export type HoldStatus = CardAuthorization['status']

export const DECLINE_COPY = {
  insufficient: 'Declined, not enough on the card',
  frozen: 'Declined, the card is frozen',
} as const

export type CardRow = {
  userId: string
  /** Zecca's id for the card (the Lithic token stays server side). */
  id: string
  token: string
  last4: string
  expMonth: number
  expYear: number
  state: CardState
  holderName: string
  createdAt: string
}

export type HoldRow = {
  authToken: string
  userId: string
  cardToken: string
  amountMinor: number
  merchant: string
  status: HoldStatus
  declineReason?: string
  orderId?: string
  settleTx?: string
  settleError?: string
  /** Our POST /v1/simulate/clearing attempts (set only on purchases Zecca itself clears: shop, test purchases). */
  clearTries?: number
  createdAt: string
  updatedAt: string
}

/**
 * A refund's money going back on the ledger, from the card settlement account to the pool (returns.ts), once per refund key.
 * pending: to send; reserved: built with this sequence and stored before the submit (it may be on the ledger);
 * sent: on the ledger; stopped: not tried again (outcome unknown, or too many tries), for a person to look at.
 */
export type ReturnStatus = 'pending' | 'reserved' | 'sent' | 'stopped'
export type ReturnRow = {
  key: string
  amountMinor: number
  status: ReturnStatus
  sequence?: number
  lastLedger?: number
  fingerprint?: string
  txHash?: string
  error?: string
  tries: number
}

type Ctx = { db: Db; iso(ms?: number): string }

const amount = (col: string) => `${col} INTEGER NOT NULL CHECK (typeof(${col}) = 'integer' AND ${col} >= 0)`

/** The connector's own tables (outside the API's migrations). Safe to run on every start. */
export function ensureCardTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS card_cards (
      user_id TEXT PRIMARY KEY,
      id TEXT NOT NULL UNIQUE,
      lithic_token TEXT NOT NULL UNIQUE,
      last4 TEXT NOT NULL,
      exp_month INTEGER NOT NULL,
      exp_year INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('OPEN', 'PAUSED', 'CLOSED')),
      holder_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS card_cards_last4 ON card_cards (last4);
    CREATE TABLE IF NOT EXISTS card_accounts (
      user_id TEXT PRIMARY KEY,
      ${amount('balance_minor')},
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_deposits (
      intent_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      ${amount('amount_minor')},
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_holds (
      auth_token TEXT PRIMARY KEY,
      seq INTEGER NOT NULL UNIQUE,
      user_id TEXT NOT NULL,
      card_token TEXT NOT NULL,
      ${amount('amount_minor')},
      merchant TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('authorised', 'completed', 'declined', 'voided', 'refunded')),
      decline_reason TEXT,
      order_id TEXT,
      settle_tx TEXT,
      settle_error TEXT,
      clear_tries INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS card_holds_user ON card_holds (user_id, seq);
    CREATE INDEX IF NOT EXISTS card_holds_status ON card_holds (status);
    CREATE TABLE IF NOT EXISTS card_shop_charges (
      order_id TEXT PRIMARY KEY,
      auth_token TEXT NOT NULL UNIQUE,
      receipt_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS card_returns (
      key TEXT PRIMARY KEY,
      ${amount('amount_minor')},
      status TEXT NOT NULL CHECK (status IN ('pending', 'reserved', 'sent', 'stopped')),
      sequence INTEGER,
      last_ledger INTEGER,
      fingerprint TEXT,
      tx_hash TEXT,
      error TEXT,
      tries INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS card_returns_status ON card_returns (status);
    CREATE TABLE IF NOT EXISTS card_kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  // Added after the first version of the table: older databases get the column here.
  if (!(db.prepare('PRAGMA table_info(card_holds)').all() as Array<{ name: string }>).some((c) => c.name === 'clear_tries'))
    db.exec('ALTER TABLE card_holds ADD COLUMN clear_tries INTEGER')
}

function assertAmount(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`invalid amount: ${n}`)
}

type CardRaw = {
  user_id: string
  id: string
  lithic_token: string
  last4: string
  exp_month: number
  exp_year: number
  state: CardState
  holder_name: string
  created_at: string
}
const cardFrom = (r: CardRaw | undefined): CardRow | undefined =>
  r && {
    userId: r.user_id,
    id: r.id,
    token: r.lithic_token,
    last4: r.last4,
    expMonth: r.exp_month,
    expYear: r.exp_year,
    state: r.state,
    holderName: r.holder_name,
    createdAt: r.created_at,
  }

type HoldRaw = {
  auth_token: string
  user_id: string
  card_token: string
  amount_minor: number
  merchant: string
  status: HoldStatus
  decline_reason: string | null
  order_id: string | null
  settle_tx: string | null
  settle_error: string | null
  clear_tries: number | null
  created_at: string
  updated_at: string
}
const holdFrom = (r: HoldRaw | undefined): HoldRow | undefined =>
  r && {
    authToken: r.auth_token,
    userId: r.user_id,
    cardToken: r.card_token,
    amountMinor: r.amount_minor,
    merchant: r.merchant,
    status: r.status,
    ...(r.decline_reason ? { declineReason: r.decline_reason } : {}),
    ...(r.order_id ? { orderId: r.order_id } : {}),
    ...(r.settle_tx ? { settleTx: r.settle_tx } : {}),
    ...(r.settle_error ? { settleError: r.settle_error } : {}),
    ...(r.clear_tries !== null ? { clearTries: r.clear_tries } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }

/** The contract's CardAuthorization for one hold. */
export function toAuthorization(h: HoldRow): CardAuthorization {
  return {
    id: h.authToken,
    amountMinor: h.amountMinor,
    merchant: h.merchant,
    approved: h.status !== 'declined',
    status: h.status,
    ...(h.declineReason ? { declineReason: h.declineReason } : {}),
    at: h.createdAt,
  }
}

type ReturnRaw = {
  key: string
  amount_minor: number
  status: ReturnStatus
  sequence: number | null
  last_ledger: number | null
  fingerprint: string | null
  tx_hash: string | null
  error: string | null
  tries: number
}
const returnFrom = (r: ReturnRaw | undefined): ReturnRow | undefined =>
  r && {
    key: r.key,
    amountMinor: r.amount_minor,
    status: r.status,
    ...(r.sequence !== null ? { sequence: r.sequence } : {}),
    ...(r.last_ledger !== null ? { lastLedger: r.last_ledger } : {}),
    ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}),
    ...(r.tx_hash ? { txHash: r.tx_hash } : {}),
    ...(r.error ? { error: r.error } : {}),
    tries: r.tries,
  }

export type CardStore = ReturnType<typeof cardStore>

export function cardStore(ctx: Ctx) {
  const { db } = ctx
  ensureCardTables(db)
  // Refunds credited before their way back to the pool existed: the pool still misses that money on the ledger.
  db.prepare(
    `INSERT OR IGNORE INTO card_returns (key, amount_minor, status, tries, created_at, updated_at)
     SELECT auth_token, amount_minor, 'pending', 0, created_at, ? FROM card_holds WHERE status = 'refunded'`,
  ).run(ctx.iso())

  const balance = (userId: string): number =>
    (db.prepare('SELECT balance_minor AS b FROM card_accounts WHERE user_id = ?').get(userId) as { b: number } | undefined)?.b ?? 0

  /** Adds a signed delta; going below zero breaks the CHECK and rolls the caller's transaction back. */
  const move = (userId: string, delta: number) => {
    const at = ctx.iso()
    const n = db.prepare('UPDATE card_accounts SET balance_minor = balance_minor + ?, updated_at = ? WHERE user_id = ?').run(delta, at, userId).changes
    if (n === 0) db.prepare('INSERT INTO card_accounts (user_id, balance_minor, updated_at) VALUES (?, ?, ?)').run(userId, delta, at)
  }

  const hold = (authToken: string) => holdFrom(db.prepare('SELECT * FROM card_holds WHERE auth_token = ?').get(authToken) as HoldRaw | undefined)

  const insertHold = (h: Omit<HoldRow, 'createdAt' | 'updatedAt'>) => {
    const at = ctx.iso()
    return (
      db
        .prepare(
          `INSERT OR IGNORE INTO card_holds (auth_token, seq, user_id, card_token, amount_minor, merchant, status, decline_reason, order_id, created_at, updated_at)
           VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM card_holds), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(h.authToken, h.userId, h.cardToken, h.amountMinor, h.merchant, h.status, h.declineReason ?? null, h.orderId ?? null, at, at).changes === 1
    )
  }

  /** Compare-and-set on a hold's status. */
  const setStatus = (authToken: string, from: HoldStatus, to: HoldStatus, extra: { amountMinor?: number } = {}) =>
    db
      .prepare(`UPDATE card_holds SET status = ?, amount_minor = COALESCE(?, amount_minor), updated_at = ? WHERE auth_token = ? AND status = ?`)
      .run(to, extra.amountMinor ?? null, ctx.iso(), authToken, from).changes === 1

  return {
    balance,
    hold,

    linkCard(userId: string, c: { id: string; token: string; last4: string; expMonth: number; expYear: number; state: CardState; holderName: string }): void {
      const at = ctx.iso()
      db.prepare(
        `INSERT INTO card_cards (user_id, id, lithic_token, last4, exp_month, exp_year, state, holder_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(userId, c.id, c.token, c.last4, c.expMonth, c.expYear, c.state, c.holderName, at, at)
    },
    cardOf: (userId: string) => cardFrom(db.prepare('SELECT * FROM card_cards WHERE user_id = ?').get(userId) as CardRaw | undefined),
    cardByToken: (token: string) => cardFrom(db.prepare('SELECT * FROM card_cards WHERE lithic_token = ?').get(token) as CardRaw | undefined),
    cardsByLast4: (last4: string) => (db.prepare('SELECT * FROM card_cards WHERE last4 = ? ORDER BY created_at').all(last4) as CardRaw[]).map((r) => cardFrom(r)!),
    allCards: () => (db.prepare('SELECT * FROM card_cards ORDER BY created_at').all() as CardRaw[]).map((r) => cardFrom(r)!),
    setCardState(userId: string, state: CardState): void {
      db.prepare('UPDATE card_cards SET state = ?, updated_at = ? WHERE user_id = ?').run(state, ctx.iso(), userId)
    },

    /** A card_load deposit the pool confirmed: credited once per intent. */
    creditDeposit(d: { intentId: string; userId: string; amountMinor: number }): { credited: boolean; balanceMinor: number } {
      assertAmount(d.amountMinor)
      const credited = db.transaction(() => {
        const fresh = db.prepare('INSERT OR IGNORE INTO card_deposits (intent_id, user_id, amount_minor, created_at) VALUES (?, ?, ?, ?)').run(d.intentId, d.userId, d.amountMinor, ctx.iso()).changes === 1
        if (fresh) move(d.userId, d.amountMinor)
        return fresh
      })()
      return { credited, balanceMinor: balance(d.userId) }
    },

    /**
     * Approve and spend if the balance covers the amount, else decline. Idempotent per authorization token: Lithic retries
     * once on a 5xx, and a retry gets the first answer.
     */
    authorize(a: { authToken: string; userId: string; cardToken: string; amountMinor: number; merchant: string; frozen?: boolean; orderId?: string }): {
      approved: boolean
      duplicate: boolean
      hold: HoldRow
    } {
      assertAmount(a.amountMinor)
      return db.transaction(() => {
        const prior = hold(a.authToken)
        if (prior) return { approved: prior.status !== 'declined', duplicate: true, hold: prior }
        const reason = a.frozen ? DECLINE_COPY.frozen : balance(a.userId) < a.amountMinor ? DECLINE_COPY.insufficient : undefined
        insertHold({
          authToken: a.authToken,
          userId: a.userId,
          cardToken: a.cardToken,
          amountMinor: a.amountMinor,
          merchant: a.merchant,
          status: reason ? 'declined' : 'authorised',
          declineReason: reason,
          orderId: a.orderId,
        })
        if (!reason) move(a.userId, -a.amountMinor)
        return { approved: !reason, duplicate: false, hold: hold(a.authToken)! }
      })()
    },

    /** Lithic voided an approved purchase: the amount goes back, once. */
    voidHold(authToken: string): boolean {
      return db.transaction(() => {
        const h = hold(authToken)
        if (!h || !setStatus(authToken, 'authorised', 'voided')) return false
        move(h.userId, h.amountMinor)
        return true
      })()
    },

    /**
     * Cleared (settled). For less than authorised: the difference goes back and the line shows what was taken. For more (a
     * tip): the extra is taken only when the card balance covers it; otherwise the purchase keeps its authorised amount.
     */
    complete(authToken: string, settledMinor?: number): boolean {
      return db.transaction(() => {
        const h = hold(authToken)
        if (!h) return false
        const asked = settledMinor !== undefined && Number.isSafeInteger(settledMinor) && settledMinor >= 0 ? settledMinor : h.amountMinor
        const settled = asked > h.amountMinor && balance(h.userId) < asked - h.amountMinor ? h.amountMinor : asked
        assertAmount(settled)
        if (!setStatus(authToken, 'authorised', 'completed', { amountMinor: settled })) return false
        if (settled !== h.amountMinor) move(h.userId, h.amountMinor - settled)
        return true
      })()
    },

    /** A return from a shop: credited once per key (the Lithic transaction), shown as its own line. */
    refund(r: { key: string; userId: string; cardToken: string; amountMinor: number; merchant: string }): boolean {
      assertAmount(r.amountMinor)
      return db.transaction(() => {
        const fresh = insertHold({ authToken: r.key, userId: r.userId, cardToken: r.cardToken, amountMinor: r.amountMinor, merchant: r.merchant, status: 'refunded' })
        if (!fresh) return false
        move(r.userId, r.amountMinor)
        const at = ctx.iso()
        db.prepare(`INSERT OR IGNORE INTO card_returns (key, amount_minor, status, tries, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)`).run(r.key, r.amountMinor, at, at)
        return true
      })()
    },

    returnOf: (key: string) => returnFrom(db.prepare('SELECT * FROM card_returns WHERE key = ?').get(key) as ReturnRaw | undefined),
    /** Refunds whose money is not back in the pool yet, oldest first (the poller sends or looks them up). */
    openReturns: () => (db.prepare("SELECT * FROM card_returns WHERE status IN ('pending', 'reserved') ORDER BY created_at, key").all() as ReturnRaw[]).map((r) => returnFrom(r)!),
    /** One more send attempt; returns the count. */
    returnTry(key: string): number {
      db.prepare('UPDATE card_returns SET tries = tries + 1, updated_at = ? WHERE key = ?').run(ctx.iso(), key)
      return returnFrom(db.prepare('SELECT * FROM card_returns WHERE key = ?').get(key) as ReturnRaw | undefined)?.tries ?? 0
    },
    /** Before the submit: a later pass looks this sequence up on the ledger before ever sending again. */
    reserveReturn(key: string, r: { sequence: number; lastLedger: number; fingerprint?: string }): void {
      db.prepare("UPDATE card_returns SET status = 'reserved', sequence = ?, last_ledger = ?, fingerprint = ?, updated_at = ? WHERE key = ? AND status IN ('pending', 'reserved')").run(
        r.sequence,
        r.lastLedger,
        r.fingerprint ?? null,
        ctx.iso(),
        key,
      )
    },
    /** On the ledger: done, and the refund line loses any earlier failure. */
    returnSent(key: string, txHash: string): void {
      db.transaction(() => {
        const at = ctx.iso()
        db.prepare("UPDATE card_returns SET status = 'sent', tx_hash = ?, error = NULL, updated_at = ? WHERE key = ?").run(txHash, at, key)
        db.prepare('UPDATE card_holds SET settle_error = NULL, updated_at = ? WHERE auth_token = ?').run(at, key)
      })()
    },
    /**
     * A failed attempt, recorded on the row and on the refund line. release: the reserved tx can never apply (send fresh next
     * time); stop: not tried again; neither: the status stays (a reserved tx whose outcome is not known yet is looked up next).
     */
    returnFailed(key: string, error: string, o: { release?: boolean; stop?: boolean } = {}): void {
      db.transaction(() => {
        const at = ctx.iso()
        const e = error.slice(0, 300)
        if (o.stop) db.prepare("UPDATE card_returns SET status = 'stopped', error = ?, updated_at = ? WHERE key = ?").run(e, at, key)
        else if (o.release)
          db.prepare("UPDATE card_returns SET status = 'pending', sequence = NULL, last_ledger = NULL, fingerprint = NULL, error = ?, updated_at = ? WHERE key = ?").run(e, at, key)
        else db.prepare('UPDATE card_returns SET error = ?, updated_at = ? WHERE key = ?').run(e, at, key)
        db.prepare('UPDATE card_holds SET settle_error = ?, updated_at = ? WHERE auth_token = ?').run(e, at, key)
      })()
    },

    annotate(authToken: string, d: { settleTx?: string; settleError?: string; orderId?: string }): void {
      db.prepare(
        `UPDATE card_holds SET settle_tx = COALESCE(?, settle_tx), settle_error = COALESCE(?, settle_error), order_id = COALESCE(?, order_id), updated_at = ?
         WHERE auth_token = ?`,
      ).run(d.settleTx ?? null, d.settleError ?? null, d.orderId ?? null, ctx.iso(), authToken)
    },

    /** One more clearing attempt by Zecca on this purchase; returns the count. */
    clearTry(authToken: string): number {
      db.prepare('UPDATE card_holds SET clear_tries = COALESCE(clear_tries, 0) + 1, updated_at = ? WHERE auth_token = ?').run(ctx.iso(), authToken)
      return hold(authToken)?.clearTries ?? 0
    },

    holdsOf: (userId: string, limit: number) =>
      (db.prepare('SELECT * FROM card_holds WHERE user_id = ? ORDER BY seq DESC LIMIT ?').all(userId, limit) as HoldRaw[]).map((r) => holdFrom(r)!),
    /** The purchase of a demo shop order that still stands (approved, not voided), if any. */
    liveHoldOfOrder: (orderId: string) =>
      holdFrom(db.prepare("SELECT * FROM card_holds WHERE order_id = ? AND status IN ('authorised', 'completed') ORDER BY seq DESC LIMIT 1").get(orderId) as HoldRaw | undefined),
    /** Approved purchases not yet cleared or voided (the poller follows them on Lithic). */
    openHolds: () => (db.prepare("SELECT * FROM card_holds WHERE status = 'authorised' ORDER BY seq").all() as HoldRaw[]).map((r) => holdFrom(r)!),

    /** The demo shop's card payment of one order, while its purchase stands (approved or cleared, not voided). */
    charge(orderId: string): { authToken: string; receipt: Receipt } | undefined {
      const r = db
        .prepare(
          `SELECT c.auth_token, c.receipt_json FROM card_shop_charges c JOIN card_holds h ON h.auth_token = c.auth_token
           WHERE c.order_id = ? AND h.status IN ('authorised', 'completed')`,
        )
        .get(orderId) as { auth_token: string; receipt_json: string } | undefined
      return r && { authToken: r.auth_token, receipt: JSON.parse(r.receipt_json) as Receipt }
    },
    chargeByAuth(authToken: string): { orderId: string; receipt: Receipt } | undefined {
      const r = db.prepare('SELECT order_id, receipt_json FROM card_shop_charges WHERE auth_token = ?').get(authToken) as { order_id: string; receipt_json: string } | undefined
      return r && { orderId: r.order_id, receipt: JSON.parse(r.receipt_json) as Receipt }
    },
    /** False when the order already has a card payment that stands; one whose purchase was voided is replaced. */
    saveCharge(orderId: string, authToken: string, receipt: Receipt): boolean {
      return (
        db
          .prepare(
            `INSERT INTO card_shop_charges (order_id, auth_token, receipt_json, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (order_id) DO UPDATE SET auth_token = excluded.auth_token, receipt_json = excluded.receipt_json, created_at = excluded.created_at
             WHERE COALESCE((SELECT status FROM card_holds WHERE auth_token = card_shop_charges.auth_token), 'gone') NOT IN ('authorised', 'completed')`,
          )
          .run(orderId, authToken, JSON.stringify(receipt), ctx.iso()).changes === 1
      )
    },
    setChargeStatus(orderId: string, status: Receipt['status']): void {
      const c = db.prepare('SELECT receipt_json FROM card_shop_charges WHERE order_id = ?').get(orderId) as { receipt_json: string } | undefined
      if (!c) return
      db.prepare('UPDATE card_shop_charges SET receipt_json = ? WHERE order_id = ?').run(JSON.stringify({ ...(JSON.parse(c.receipt_json) as Receipt), status }), orderId)
    },

    getKv: (key: string) => (db.prepare('SELECT value FROM card_kv WHERE key = ?').get(key) as { value: string } | undefined)?.value,
    setKv(key: string, value: string): void {
      db.prepare('INSERT INTO card_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(
        key,
        value,
        ctx.iso(),
      )
    },
  }
}
