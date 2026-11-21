// The withdrawal (MoonPay sell) tables, created with IF NOT EXISTS like the rest of the ramp's. One withdrawal per MoonPay
// sell transaction, tied to one 'withdraw' intent (the user's deposit to the pool); the treasury payment's hash and
// LastLedgerSequence are stored before it is submitted, so a restart can settle it from the ledger. ramp_sell_txs keeps
// MoonPay's own view of a sale (from its API and signed webhooks), which can arrive before the withdrawal exists.
import type { Db } from '../../db'
import type { DeliveredCurrency } from './delivery'

export function ensureSellTables(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ramp_withdrawals (
      moonpay_tx_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL UNIQUE,
      external_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      currency TEXT NOT NULL CHECK (currency IN ('RLUSD', 'XRP')),
      crypto_amount TEXT NOT NULL,
      amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
      destination TEXT NOT NULL,
      destination_tag INTEGER,
      destination_source TEXT NOT NULL CHECK (destination_source IN ('moonpay', 'widget')),
      status TEXT NOT NULL CHECK (status IN ('awaiting_approval', 'paying', 'sent', 'delivered', 'paid_out', 'failed', 'moonpay_failed')),
      pay_hash TEXT UNIQUE,
      pay_lls INTEGER,
      moonpay_status TEXT,
      refund_intent_id TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ramp_withdrawals_status ON ramp_withdrawals (status);

    CREATE TABLE IF NOT EXISTS ramp_sell_txs (
      moonpay_tx_id TEXT PRIMARY KEY,
      external_id TEXT NOT NULL,
      status TEXT,
      deposit_address TEXT,
      deposit_tag TEXT,
      updated_at TEXT NOT NULL
    );
  `)
}

export type WithdrawalStatus = 'awaiting_approval' | 'paying' | 'sent' | 'delivered' | 'paid_out' | 'failed' | 'moonpay_failed'

export type Withdrawal = {
  moonpayTxId: string
  intentId: string
  externalId: string
  userId: string
  currency: DeliveredCurrency
  cryptoAmount: string
  amountMinor: number
  destination: string
  destinationTag?: number
  destinationSource: 'moonpay' | 'widget'
  status: WithdrawalStatus
  payHash?: string
  payLls?: number
  moonpayStatus?: string
  refundIntentId?: string
  reason?: string
  createdAt: string
  updatedAt: string
}

type Raw = {
  moonpay_tx_id: string
  intent_id: string
  external_id: string
  user_id: string
  currency: DeliveredCurrency
  crypto_amount: string
  amount_minor: number
  destination: string
  destination_tag: number | null
  destination_source: 'moonpay' | 'widget'
  status: WithdrawalStatus
  pay_hash: string | null
  pay_lls: number | null
  moonpay_status: string | null
  refund_intent_id: string | null
  reason: string | null
  created_at: string
  updated_at: string
}

const fromRaw = (r: Raw): Withdrawal => ({
  moonpayTxId: r.moonpay_tx_id,
  intentId: r.intent_id,
  externalId: r.external_id,
  userId: r.user_id,
  currency: r.currency,
  cryptoAmount: r.crypto_amount,
  amountMinor: r.amount_minor,
  destination: r.destination,
  destinationTag: r.destination_tag ?? undefined,
  destinationSource: r.destination_source,
  status: r.status,
  payHash: r.pay_hash ?? undefined,
  payLls: r.pay_lls ?? undefined,
  moonpayStatus: r.moonpay_status ?? undefined,
  refundIntentId: r.refund_intent_id ?? undefined,
  reason: r.reason ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

type Patch = Partial<Pick<Withdrawal, 'moonpayStatus' | 'refundIntentId' | 'reason' | 'destinationSource' | 'destinationTag'>>
const PATCH_COLS: Record<keyof Patch, string> = {
  moonpayStatus: 'moonpay_status',
  refundIntentId: 'refund_intent_id',
  reason: 'reason',
  destinationSource: 'destination_source',
  destinationTag: 'destination_tag',
}

export const withdrawals = {
  /** A new withdrawal, or the same sale again with a new intent (the earlier one was never submitted). */
  upsert(db: Db, w: Omit<Withdrawal, 'createdAt' | 'updatedAt' | 'status' | 'payHash' | 'payLls' | 'refundIntentId' | 'reason' | 'moonpayStatus'>, atIso: string): void {
    db.prepare(
      `INSERT INTO ramp_withdrawals (moonpay_tx_id, intent_id, external_id, user_id, currency, crypto_amount, amount_minor, destination, destination_tag,
         destination_source, status, created_at, updated_at)
       VALUES (@moonpayTxId, @intentId, @externalId, @userId, @currency, @cryptoAmount, @amountMinor, @destination, @destinationTag, @destinationSource,
         'awaiting_approval', @at, @at)
       ON CONFLICT (moonpay_tx_id) DO UPDATE SET intent_id = excluded.intent_id, crypto_amount = excluded.crypto_amount, amount_minor = excluded.amount_minor,
         destination = excluded.destination, destination_tag = excluded.destination_tag, destination_source = excluded.destination_source,
         status = 'awaiting_approval', reason = NULL, updated_at = excluded.updated_at
       WHERE ramp_withdrawals.status IN ('awaiting_approval', 'failed') AND ramp_withdrawals.pay_hash IS NULL`,
    ).run({ ...w, destinationTag: w.destinationTag ?? null, at: atIso })
  },
  byMoonPayId(db: Db, id: string): Withdrawal | undefined {
    const r = db.prepare('SELECT * FROM ramp_withdrawals WHERE moonpay_tx_id = ?').get(id) as Raw | undefined
    return r && fromRaw(r)
  },
  byIntent(db: Db, intentId: string): Withdrawal | undefined {
    const r = db.prepare('SELECT * FROM ramp_withdrawals WHERE intent_id = ?').get(intentId) as Raw | undefined
    return r && fromRaw(r)
  },
  withStatus(db: Db, statuses: WithdrawalStatus[]): Withdrawal[] {
    return (db.prepare(`SELECT * FROM ramp_withdrawals WHERE status IN (${statuses.map(() => '?').join(', ')}) ORDER BY created_at`).all(...statuses) as Raw[]).map(fromRaw)
  },
  /** Compare-and-set on the status; false when the row was not in one of `from`. */
  move(db: Db, intentId: string, from: WithdrawalStatus[], to: WithdrawalStatus, atIso: string, p: Patch = {}): boolean {
    const changed =
      db
        .prepare(`UPDATE ramp_withdrawals SET status = ?, updated_at = ? WHERE intent_id = ? AND status IN (${from.map(() => '?').join(', ')})`)
        .run(to, atIso, intentId, ...from).changes === 1
    if (changed) withdrawals.patch(db, intentId, p, atIso)
    return changed
  },
  /** paying -> sent with the signed payment's hash and LastLedgerSequence, before it is submitted. */
  markSent(db: Db, intentId: string, hash: string, lls: number, atIso: string): boolean {
    return (
      db
        .prepare("UPDATE ramp_withdrawals SET status = 'sent', pay_hash = ?, pay_lls = ?, updated_at = ? WHERE intent_id = ? AND status = 'paying' AND pay_hash IS NULL")
        .run(hash, lls, atIso, intentId).changes === 1
    )
  },
  patch(db: Db, intentId: string, p: Patch, atIso: string): void {
    const sets: string[] = []
    const v: Record<string, unknown> = { id: intentId, at: atIso }
    for (const [k, col] of Object.entries(PATCH_COLS)) {
      if (k in p) {
        sets.push(`${col} = @${k}`)
        v[k] = (p as Record<string, unknown>)[k] ?? null
      }
    }
    if (!sets.length) return
    db.prepare(`UPDATE ramp_withdrawals SET ${sets.join(', ')}, updated_at = @at WHERE intent_id = @id`).run(v)
  },
}

export type SellRecord = { moonpayTxId: string; externalId: string; status?: string; depositAddress?: string; depositTag?: string }

/** MoonPay's own view of a sale. A field MoonPay leaves out keeps what we had. */
export const sellTxs = {
  record(db: Db, r: SellRecord, atIso: string): void {
    db.prepare(
      `INSERT INTO ramp_sell_txs (moonpay_tx_id, external_id, status, deposit_address, deposit_tag, updated_at) VALUES (@id, @ext, @status, @addr, @tag, @at)
       ON CONFLICT (moonpay_tx_id) DO UPDATE SET status = COALESCE(excluded.status, status), deposit_address = COALESCE(excluded.deposit_address, deposit_address),
         deposit_tag = COALESCE(excluded.deposit_tag, deposit_tag), updated_at = excluded.updated_at`,
    ).run({ id: r.moonpayTxId, ext: r.externalId, status: r.status ?? null, addr: r.depositAddress ?? null, tag: r.depositTag ?? null, at: atIso })
  },
  get(db: Db, moonpayTxId: string): SellRecord | undefined {
    const r = db.prepare('SELECT * FROM ramp_sell_txs WHERE moonpay_tx_id = ?').get(moonpayTxId) as
      | { moonpay_tx_id: string; external_id: string; status: string | null; deposit_address: string | null; deposit_tag: string | null }
      | undefined
    return r && { moonpayTxId: r.moonpay_tx_id, externalId: r.external_id, status: r.status ?? undefined, depositAddress: r.deposit_address ?? undefined, depositTag: r.deposit_tag ?? undefined }
  },
}
