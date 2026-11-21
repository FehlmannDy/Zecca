// The ramp connector's own tables: widget sessions (our externalTransactionId bound to a user) and credits (one per MoonPay
// transaction and per Testnet delivery hash, whatever the outcome). Created here with IF NOT EXISTS so the module stays
// self-contained; amounts are integer cents, checked by the schema.
import type { Db } from '../../db'

export function ensureRampTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ramp_sessions (
      external_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
      currency_code TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      fiat_amount TEXT,
      fiat_currency TEXT,
      created_at TEXT NOT NULL,
      done_at TEXT
    );
    CREATE INDEX IF NOT EXISTS ramp_sessions_open ON ramp_sessions (done_at, created_at);

    CREATE TABLE IF NOT EXISTS ramp_credits (
      moonpay_tx_id TEXT PRIMARY KEY,
      delivery_hash TEXT NOT NULL UNIQUE,
      external_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('credited', 'refused_limit', 'rejected', 'mint_failed')),
      currency TEXT,
      delivered TEXT,
      amount_minor INTEGER CHECK (amount_minor IS NULL OR (typeof(amount_minor) = 'integer' AND amount_minor >= 0)),
      intent_id TEXT,
      mint_hash TEXT,
      reason TEXT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
}

export type RampSession = {
  externalId: string
  userId: string
  direction: 'buy' | 'sell'
  currencyCode: string
  walletAddress: string
  ipHash: string
  fiatAmount?: string
  fiatCurrency?: string
  createdAt: string
  doneAt?: string
}

type SessionRaw = {
  external_id: string
  user_id: string
  direction: 'buy' | 'sell'
  currency_code: string
  wallet_address: string
  ip_hash: string
  fiat_amount: string | null
  fiat_currency: string | null
  created_at: string
  done_at: string | null
}
const sessionFromRaw = (r: SessionRaw): RampSession => ({
  externalId: r.external_id,
  userId: r.user_id,
  direction: r.direction,
  currencyCode: r.currency_code,
  walletAddress: r.wallet_address,
  ipHash: r.ip_hash,
  fiatAmount: r.fiat_amount ?? undefined,
  fiatCurrency: r.fiat_currency ?? undefined,
  createdAt: r.created_at,
  doneAt: r.done_at ?? undefined,
})

export type CreditStatus = 'credited' | 'refused_limit' | 'rejected' | 'mint_failed'
export type RampCredit = {
  moonpayTxId: string
  deliveryHash: string
  externalId: string
  userId: string
  status: CreditStatus
  currency?: string
  delivered?: string
  amountMinor?: number
  intentId?: string
  mintHash?: string
  reason?: string
  source: string
}

type CreditRaw = {
  moonpay_tx_id: string
  delivery_hash: string
  external_id: string
  user_id: string
  status: CreditStatus
  currency: string | null
  delivered: string | null
  amount_minor: number | null
  intent_id: string | null
  mint_hash: string | null
  reason: string | null
  source: string
}
const creditFromRaw = (r: CreditRaw): RampCredit => ({
  moonpayTxId: r.moonpay_tx_id,
  deliveryHash: r.delivery_hash,
  externalId: r.external_id,
  userId: r.user_id,
  status: r.status,
  currency: r.currency ?? undefined,
  delivered: r.delivered ?? undefined,
  amountMinor: r.amount_minor ?? undefined,
  intentId: r.intent_id ?? undefined,
  mintHash: r.mint_hash ?? undefined,
  reason: r.reason ?? undefined,
  source: r.source,
})

export const rampSessions = {
  insert(db: Db, s: Omit<RampSession, 'doneAt'>): void {
    db.prepare(
      `INSERT INTO ramp_sessions (external_id, user_id, direction, currency_code, wallet_address, ip_hash, fiat_amount, fiat_currency, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(s.externalId, s.userId, s.direction, s.currencyCode, s.walletAddress, s.ipHash, s.fiatAmount ?? null, s.fiatCurrency ?? null, s.createdAt)
  },
  byExternalId(db: Db, id: unknown): RampSession | undefined {
    if (typeof id !== 'string' || !id) return undefined
    const r = db.prepare('SELECT * FROM ramp_sessions WHERE external_id = ?').get(id) as SessionRaw | undefined
    return r && sessionFromRaw(r)
  },
  /** Top-up sessions with no outcome yet created at or after `sinceIso`, newest first, at most `perUser` per user (so no one crowds out another). */
  open(db: Db, sinceIso: string, perUser: number): RampSession[] {
    return (
      db
        .prepare(
          `SELECT * FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS nth FROM ramp_sessions WHERE direction = 'buy' AND done_at IS NULL AND created_at >= ?)
           WHERE nth <= ? ORDER BY created_at DESC`,
        )
        .all(sinceIso, perUser) as SessionRaw[]
    ).map(sessionFromRaw)
  },
  markDone(db: Db, externalId: string, atIso: string): void {
    db.prepare('UPDATE ramp_sessions SET done_at = COALESCE(done_at, ?) WHERE external_id = ?').run(atIso, externalId)
  },
}

export const rampCredits = {
  /** One row per MoonPay transaction and per delivery hash: false when either is already recorded. */
  insert(db: Db, c: RampCredit, atIso: string): boolean {
    return (
      db
        .prepare(
          `INSERT OR IGNORE INTO ramp_credits (moonpay_tx_id, delivery_hash, external_id, user_id, status, currency, delivered, amount_minor, intent_id, mint_hash, reason, source, created_at, updated_at)
           VALUES (@moonpayTxId, @deliveryHash, @externalId, @userId, @status, @currency, @delivered, @amountMinor, @intentId, @mintHash, @reason, @source, @at, @at)`,
        )
        .run({
          currency: null,
          delivered: null,
          amountMinor: null,
          intentId: null,
          mintHash: null,
          reason: null,
          ...Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)),
          at: atIso,
        }).changes === 1
    )
  },
  byMoonPayId(db: Db, id: string): RampCredit | undefined {
    const r = db.prepare('SELECT * FROM ramp_credits WHERE moonpay_tx_id = ?').get(id) as CreditRaw | undefined
    return r && creditFromRaw(r)
  },
  byHash(db: Db, hash: string): RampCredit | undefined {
    const r = db.prepare('SELECT * FROM ramp_credits WHERE delivery_hash = ?').get(hash) as CreditRaw | undefined
    return r && creditFromRaw(r)
  },
  withStatus(db: Db, status: CreditStatus): RampCredit[] {
    return (db.prepare('SELECT * FROM ramp_credits WHERE status = ?').all(status) as CreditRaw[]).map(creditFromRaw)
  },
  patch(db: Db, moonpayTxId: string, p: Partial<Pick<RampCredit, 'status' | 'intentId' | 'mintHash' | 'reason'>>, atIso: string): void {
    db.prepare(
      `UPDATE ramp_credits SET status = COALESCE(@status, status), intent_id = COALESCE(@intentId, intent_id), mint_hash = COALESCE(@mintHash, mint_hash),
         reason = COALESCE(@reason, reason), updated_at = @at WHERE moonpay_tx_id = @id`,
    ).run({ status: p.status ?? null, intentId: p.intentId ?? null, mintHash: p.mintHash ?? null, reason: p.reason ?? null, at: atIso, id: moonpayTxId })
  },
}
