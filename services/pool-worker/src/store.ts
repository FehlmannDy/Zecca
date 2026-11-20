// Pool worker persistence: expected deposits, credited hashes (credited once), payouts per intent (sent once), mints per reference.
// Two implementations with the same behaviour: in memory (tests, mock mode) and SQLite (devnet; survives a restart).
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'

export type DepositStatus = 'pending' | 'received' | 'failed'
export type ExpectedDeposit = {
  intentId: string
  txHash: string
  from: string
  amountMinor: number
  status: DepositStatus
  /** Failure code when status is 'failed' (e.g. 'amount_mismatch'). */
  code?: string
  /** Failure message when status is 'failed' (delivered again with the code). */
  message?: string
}

/** reserved: Sequence persisted, submit may or may not have reached the ledger. sent: confirmed hash. failed: no money moved, or unknown (manual). */
export type PayoutStatus = 'reserved' | 'sent' | 'failed'
export type PayoutRecord = {
  intentId: string
  to: string
  amountMinor: number
  status: PayoutStatus
  reservedSequence: number | null
  lastLedgerSequence: number | null
  /** Identifies the exact tx built for the reserved sequence (its fresh ciphertext), so another tx on that sequence is never taken for it. */
  fingerprint?: string
  txHash?: string
  error?: string
}

export type MintStatus = 'paying' | 'paid' | 'converting' | 'done' | 'failed'
export type MintRecord = {
  /** The Testnet delivery hash (SPEC §2.7), or any unique reference. */
  reference: string
  amountMinor: number
  status: MintStatus
  paymentHash?: string
  convertSequence?: number | null
  convertLastLedgerSequence?: number | null
  convertFingerprint?: string
  convertHash?: string
  error?: string
}

export interface PoolStore {
  putDeposit(d: ExpectedDeposit): void
  getDeposit(txHash: string): ExpectedDeposit | undefined
  pendingDeposits(): ExpectedDeposit[]
  /**
   * Credits an expected deposit: marks its hash credited and the deposit 'received' in one atomic step.
   * True the first time, false ever after, and false (nothing marked) when no deposit is expected for that hash.
   */
  creditDeposit(txHash: string): boolean
  isCredited(txHash: string): boolean
  putPayout(p: PayoutRecord): void
  getPayout(intentId: string): PayoutRecord | undefined
  payouts(): PayoutRecord[]
  putMint(m: MintRecord): void
  getMint(reference: string): MintRecord | undefined
  close(): void
}

const copy = <T>(v: T | undefined): T | undefined => (v === undefined ? undefined : structuredClone(v))

export function createMemoryPoolStore(): PoolStore {
  const deposits = new Map<string, ExpectedDeposit>()
  const credited = new Set<string>()
  const payouts = new Map<string, PayoutRecord>()
  const mints = new Map<string, MintRecord>()
  return {
    putDeposit: (d) => void deposits.set(d.txHash, structuredClone(d)),
    getDeposit: (h) => copy(deposits.get(h)),
    pendingDeposits: () => [...deposits.values()].filter((d) => d.status === 'pending').map((d) => structuredClone(d)),
    creditDeposit(h) {
      const d = deposits.get(h)
      if (!d || credited.has(h)) return false
      credited.add(h)
      deposits.set(h, { ...d, status: 'received' })
      return true
    },
    isCredited: (h) => credited.has(h),
    putPayout: (p) => void payouts.set(p.intentId, structuredClone(p)),
    getPayout: (id) => copy(payouts.get(id)),
    payouts: () => [...payouts.values()].map((p) => structuredClone(p)),
    putMint: (m) => void mints.set(m.reference, structuredClone(m)),
    getMint: (r) => copy(mints.get(r)),
    close: () => {},
  }
}

// better-sqlite3 ships no types and @types/better-sqlite3 is not installed; type the few calls used here locally.
type Statement = { run(...p: unknown[]): { changes: number }; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] }
type Database = { pragma(s: string): unknown; exec(sql: string): unknown; prepare(sql: string): Statement; transaction<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R; close(): void }
type DatabaseCtor = new (path: string) => Database

export function createSqlitePoolStore(path: string): PoolStore {
  const Sqlite = createRequire(import.meta.url)('better-sqlite3') as DatabaseCtor
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Sqlite(path)
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = FULL') // a reserved payout sequence must be on disk before the submit
  db.exec(`
    CREATE TABLE IF NOT EXISTS deposits (tx_hash TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS credited (tx_hash TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS payouts (intent_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mints (reference TEXT PRIMARY KEY, data TEXT NOT NULL);
  `)
  const q = {
    putDeposit: db.prepare('INSERT INTO deposits (tx_hash, status, data) VALUES (?, ?, ?) ON CONFLICT(tx_hash) DO UPDATE SET status = excluded.status, data = excluded.data'),
    getDeposit: db.prepare('SELECT data FROM deposits WHERE tx_hash = ?'),
    pending: db.prepare("SELECT data FROM deposits WHERE status = 'pending' ORDER BY rowid"),
    credit: db.prepare('INSERT OR IGNORE INTO credited (tx_hash, at) VALUES (?, ?)'),
    isCredited: db.prepare('SELECT 1 FROM credited WHERE tx_hash = ?'),
    putPayout: db.prepare('INSERT INTO payouts (intent_id, data) VALUES (?, ?) ON CONFLICT(intent_id) DO UPDATE SET data = excluded.data'),
    getPayout: db.prepare('SELECT data FROM payouts WHERE intent_id = ?'),
    payouts: db.prepare('SELECT data FROM payouts ORDER BY rowid'),
    putMint: db.prepare('INSERT INTO mints (reference, data) VALUES (?, ?) ON CONFLICT(reference) DO UPDATE SET data = excluded.data'),
    getMint: db.prepare('SELECT data FROM mints WHERE reference = ?'),
  }
  const one = <T>(row: unknown): T | undefined => (row ? (JSON.parse((row as { data: string }).data) as T) : undefined)
  const all = <T>(rows: unknown[]): T[] => rows.map((r) => JSON.parse((r as { data: string }).data) as T)
  // One transaction: a crash can never leave a deposit credited but still pending.
  const creditDeposit = db.transaction((h: string): boolean => {
    const d = one<ExpectedDeposit>(q.getDeposit.get(h))
    if (!d || q.credit.run(h, Date.now()).changes !== 1) return false
    q.putDeposit.run(h, 'received', JSON.stringify({ ...d, status: 'received' }))
    return true
  })
  return {
    putDeposit: (d) => void q.putDeposit.run(d.txHash, d.status, JSON.stringify(d)),
    getDeposit: (h) => one<ExpectedDeposit>(q.getDeposit.get(h)),
    pendingDeposits: () => all<ExpectedDeposit>(q.pending.all()),
    creditDeposit,
    isCredited: (h) => Boolean(q.isCredited.get(h)),
    putPayout: (p) => void q.putPayout.run(p.intentId, JSON.stringify(p)),
    getPayout: (id) => one<PayoutRecord>(q.getPayout.get(id)),
    payouts: () => all<PayoutRecord>(q.payouts.all()),
    putMint: (m) => void q.putMint.run(m.reference, JSON.stringify(m)),
    getMint: (r) => one<MintRecord>(q.getMint.get(r)),
    close: () => db.close(),
  }
}
