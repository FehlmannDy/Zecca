// Earn's own tables (created from the connector's init, CREATE TABLE IF NOT EXISTS; the shared migrations are not touched).
import type { Core } from '../../core'

export function initEarnTables(core: Core): void {
  core.db.exec(`
    CREATE TABLE IF NOT EXISTS earn_deposits (
      intent_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_minor INTEGER NOT NULL,
      swap_fee_minor INTEGER NOT NULL,
      rate_micro INTEGER NOT NULL,
      rate_at TEXT NOT NULL,
      rate_source TEXT NOT NULL,
      xrp_drops INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('quoted', 'funding', 'opening', 'active', 'failed')),
      testnet_address TEXT,
      personal_account TEXT,
      vault_hash TEXT,
      opened_at TEXT,
      active_at TEXT,
      failure TEXT,
      refunded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS earn_deposits_user ON earn_deposits (user_id, created_at);
    CREATE TABLE IF NOT EXISTS earn_withdrawals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      requested_drops INTEGER NOT NULL,
      shares TEXT NOT NULL,
      cost_basis_drops INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('requesting', 'requested', 'claiming', 'redeeming', 'credited', 'failed')),
      period TEXT,
      owed_drops INTEGER,
      claimable_at TEXT NOT NULL,
      redeemed_drops INTEGER,
      fee_drops INTEGER,
      credit_minor INTEGER,
      credit_intent_id TEXT,
      failure TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS earn_withdrawals_user ON earn_withdrawals (user_id, created_at);
    CREATE TABLE IF NOT EXISTS earn_steps (
      key TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      blob TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('signed', 'validated')),
      engine_result TEXT,
      validated_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS earn_points (
      user_id TEXT NOT NULL,
      at TEXT NOT NULL,
      value_drops INTEGER NOT NULL,
      PRIMARY KEY (user_id, at)
    );
  `)
}

// ---------- deposits ----------
export type DepositStatus = 'quoted' | 'funding' | 'opening' | 'active' | 'failed'
export type DepositRow = {
  intentId: string
  userId: string
  amountMinor: number
  swapFeeMinor: number
  rateMicro: number
  rateAt: string
  rateSource: string
  xrpDrops: number
  status: DepositStatus
  testnetAddress?: string
  personalAccount?: string
  vaultHash?: string
  openedAt?: string
  activeAt?: string
  failure?: string
  refunded: boolean
  createdAt: string
  updatedAt: string
}
type DepRaw = {
  intent_id: string
  user_id: string
  amount_minor: number
  swap_fee_minor: number
  rate_micro: number
  rate_at: string
  rate_source: string
  xrp_drops: number
  status: DepositStatus
  testnet_address: string | null
  personal_account: string | null
  vault_hash: string | null
  opened_at: string | null
  active_at: string | null
  failure: string | null
  refunded: number
  created_at: string
  updated_at: string
}
const dep = (r: DepRaw): DepositRow => ({
  intentId: r.intent_id,
  userId: r.user_id,
  amountMinor: r.amount_minor,
  swapFeeMinor: r.swap_fee_minor,
  rateMicro: r.rate_micro,
  rateAt: r.rate_at,
  rateSource: r.rate_source,
  xrpDrops: r.xrp_drops,
  status: r.status,
  testnetAddress: r.testnet_address ?? undefined,
  personalAccount: r.personal_account ?? undefined,
  vaultHash: r.vault_hash ?? undefined,
  openedAt: r.opened_at ?? undefined,
  activeAt: r.active_at ?? undefined,
  failure: r.failure ?? undefined,
  refunded: r.refunded === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

type DepPatch = Partial<Pick<DepositRow, 'status' | 'testnetAddress' | 'personalAccount' | 'vaultHash' | 'openedAt' | 'activeAt' | 'failure' | 'refunded'>>
const DEP_COLS: Record<keyof DepPatch, string> = {
  status: 'status',
  testnetAddress: 'testnet_address',
  personalAccount: 'personal_account',
  vaultHash: 'vault_hash',
  openedAt: 'opened_at',
  activeAt: 'active_at',
  failure: 'failure',
  refunded: 'refunded',
}

function patchSql(table: string, keyCol: string, cols: Record<string, string>, p: Record<string, unknown>) {
  const sets: string[] = []
  const v: Record<string, unknown> = {}
  for (const [k, c] of Object.entries(cols)) {
    if (!(k in p)) continue
    sets.push(`${c} = @${k}`)
    const x = p[k]
    v[k] = typeof x === 'boolean' ? (x ? 1 : 0) : (x ?? null)
  }
  return { sql: `UPDATE ${table} SET ${sets.join(', ')}, updated_at = @at WHERE ${keyCol} = @key`, v, empty: !sets.length }
}

export const deposits = {
  insert(core: Core, d: Omit<DepositRow, 'createdAt' | 'updatedAt' | 'refunded' | 'status'>): void {
    const at = core.iso()
    core.db
      .prepare(
        `INSERT INTO earn_deposits (intent_id, user_id, amount_minor, swap_fee_minor, rate_micro, rate_at, rate_source, xrp_drops, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'quoted', ?, ?)`,
      )
      .run(d.intentId, d.userId, d.amountMinor, d.swapFeeMinor, d.rateMicro, d.rateAt, d.rateSource, d.xrpDrops, at, at)
  },
  get(core: Core, intentId: string): DepositRow | undefined {
    const r = core.db.prepare('SELECT * FROM earn_deposits WHERE intent_id = ?').get(intentId) as DepRaw | undefined
    return r && dep(r)
  },
  ofUser(core: Core, userId: string): DepositRow[] {
    return (core.db.prepare('SELECT * FROM earn_deposits WHERE user_id = ? ORDER BY created_at, rowid').all(userId) as DepRaw[]).map(dep)
  },
  inFlight(core: Core): DepositRow[] {
    return (core.db.prepare("SELECT * FROM earn_deposits WHERE status IN ('funding', 'opening') ORDER BY created_at").all() as DepRaw[]).map(dep)
  },
  patch(core: Core, intentId: string, p: DepPatch): void {
    const q = patchSql('earn_deposits', 'intent_id', DEP_COLS, p)
    if (!q.empty) core.db.prepare(q.sql).run({ ...q.v, at: core.iso(), key: intentId })
  },
  /** Compare-and-set on the status. */
  move(core: Core, intentId: string, from: DepositStatus[], to: DepositStatus, p: DepPatch = {}): boolean {
    const ok =
      core.db
        .prepare(`UPDATE earn_deposits SET status = ?, updated_at = ? WHERE intent_id = ? AND status IN (${from.map(() => '?').join(', ')})`)
        .run(to, core.iso(), intentId, ...from).changes === 1
    if (ok) deposits.patch(core, intentId, p)
    return ok
  },
}

// ---------- withdrawals ----------
export type WithdrawalStatus = 'requesting' | 'requested' | 'claiming' | 'redeeming' | 'credited' | 'failed'
export const OPEN_WITHDRAWAL: WithdrawalStatus[] = ['requesting', 'requested', 'claiming', 'redeeming']
export type WithdrawalRow = {
  id: string
  userId: string
  requestedDrops: number
  shares: bigint
  costBasisDrops: number
  status: WithdrawalStatus
  period?: bigint
  owedDrops?: number
  claimableAt: string
  redeemedDrops?: number
  feeDrops?: number
  creditMinor?: number
  creditIntentId?: string
  failure?: string
  createdAt: string
  updatedAt: string
}
type WRaw = {
  id: string
  user_id: string
  requested_drops: number
  shares: string
  cost_basis_drops: number
  status: WithdrawalStatus
  period: string | null
  owed_drops: number | null
  claimable_at: string
  redeemed_drops: number | null
  fee_drops: number | null
  credit_minor: number | null
  credit_intent_id: string | null
  failure: string | null
  created_at: string
  updated_at: string
}
const wd = (r: WRaw): WithdrawalRow => ({
  id: r.id,
  userId: r.user_id,
  requestedDrops: r.requested_drops,
  shares: BigInt(r.shares),
  costBasisDrops: r.cost_basis_drops,
  status: r.status,
  period: r.period === null ? undefined : BigInt(r.period),
  owedDrops: r.owed_drops ?? undefined,
  claimableAt: r.claimable_at,
  redeemedDrops: r.redeemed_drops ?? undefined,
  feeDrops: r.fee_drops ?? undefined,
  creditMinor: r.credit_minor ?? undefined,
  creditIntentId: r.credit_intent_id ?? undefined,
  failure: r.failure ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})
type WPatch = Partial<Pick<WithdrawalRow, 'period' | 'owedDrops' | 'claimableAt' | 'redeemedDrops' | 'feeDrops' | 'creditMinor' | 'creditIntentId' | 'failure'>>
const W_COLS: Record<keyof WPatch, string> = {
  period: 'period',
  owedDrops: 'owed_drops',
  claimableAt: 'claimable_at',
  redeemedDrops: 'redeemed_drops',
  feeDrops: 'fee_drops',
  creditMinor: 'credit_minor',
  creditIntentId: 'credit_intent_id',
  failure: 'failure',
}

export const withdrawals = {
  /** Inserts a new withdrawal unless the user already has one open. Returns false then. */
  insertIfNoneOpen(core: Core, w: Pick<WithdrawalRow, 'id' | 'userId' | 'requestedDrops' | 'shares' | 'costBasisDrops' | 'claimableAt'>): boolean {
    return core.db.transaction(() => {
      if (withdrawals.open(core, w.userId)) return false
      const at = core.iso()
      core.db
        .prepare(
          `INSERT INTO earn_withdrawals (id, user_id, requested_drops, shares, cost_basis_drops, status, claimable_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'requesting', ?, ?, ?)`,
        )
        .run(w.id, w.userId, w.requestedDrops, w.shares.toString(), w.costBasisDrops, w.claimableAt, at, at)
      return true
    })()
  },
  get(core: Core, id: string): WithdrawalRow | undefined {
    const r = core.db.prepare('SELECT * FROM earn_withdrawals WHERE id = ?').get(id) as WRaw | undefined
    return r && wd(r)
  },
  open(core: Core, userId: string): WithdrawalRow | undefined {
    const r = core.db
      .prepare(`SELECT * FROM earn_withdrawals WHERE user_id = ? AND status IN (${OPEN_WITHDRAWAL.map(() => '?').join(', ')}) ORDER BY created_at DESC LIMIT 1`)
      .get(userId, ...OPEN_WITHDRAWAL) as WRaw | undefined
    return r && wd(r)
  },
  ofUser(core: Core, userId: string): WithdrawalRow[] {
    return (core.db.prepare('SELECT * FROM earn_withdrawals WHERE user_id = ? ORDER BY created_at').all(userId) as WRaw[]).map(wd)
  },
  withStatus(core: Core, s: WithdrawalStatus[]): WithdrawalRow[] {
    return (core.db.prepare(`SELECT * FROM earn_withdrawals WHERE status IN (${s.map(() => '?').join(', ')}) ORDER BY created_at`).all(...s) as WRaw[]).map(wd)
  },
  patch(core: Core, id: string, p: WPatch): void {
    const q = patchSql('earn_withdrawals', 'id', W_COLS, { ...p, ...(p.period !== undefined ? { period: p.period.toString() } : {}) })
    if (!q.empty) core.db.prepare(q.sql).run({ ...q.v, at: core.iso(), key: id })
  },
  move(core: Core, id: string, from: WithdrawalStatus[], to: WithdrawalStatus, p: WPatch = {}): boolean {
    const ok =
      core.db
        .prepare(`UPDATE earn_withdrawals SET status = ?, updated_at = ? WHERE id = ? AND status IN (${from.map(() => '?').join(', ')})`)
        .run(to, core.iso(), id, ...from).changes === 1
    if (ok) withdrawals.patch(core, id, p)
    return ok
  },
}

// ---------- signed Testnet payments, one row per step (crash-safe: the hash is stored before the blob is sent) ----------
export type StepRow = { key: string; hash: string; blob: string; status: 'signed' | 'validated'; engineResult?: string; validatedAt?: string }
export const steps = {
  get(core: Core, key: string): StepRow | undefined {
    const r = core.db.prepare('SELECT * FROM earn_steps WHERE key = ?').get(key) as
      | { key: string; hash: string; blob: string; status: 'signed' | 'validated'; engine_result: string | null; validated_at: string | null }
      | undefined
    return r && { key: r.key, hash: r.hash, blob: r.blob, status: r.status, engineResult: r.engine_result ?? undefined, validatedAt: r.validated_at ?? undefined }
  },
  insert(core: Core, key: string, s: { hash: string; blob: string }): void {
    core.db.prepare("INSERT INTO earn_steps (key, hash, blob, status, created_at) VALUES (?, ?, ?, 'signed', ?)").run(key, s.hash, s.blob, core.iso())
  },
  validated(core: Core, key: string, engineResult: string): void {
    core.db.prepare("UPDATE earn_steps SET status = 'validated', engine_result = ?, validated_at = COALESCE(validated_at, ?) WHERE key = ?").run(engineResult, core.iso(), key)
  },
  /** The blob never reached the ledger and cannot any more: the next attempt signs a new one. */
  drop(core: Core, key: string): void {
    core.db.prepare("DELETE FROM earn_steps WHERE key = ? AND status = 'signed'").run(key)
  },
}

// ---------- history points (real reads only) ----------
export const points = {
  ofUser(core: Core, userId: string): { at: string; valueDrops: number }[] {
    return (core.db.prepare('SELECT at, value_drops FROM earn_points WHERE user_id = ? ORDER BY at').all(userId) as { at: string; value_drops: number }[]).map((r) => ({
      at: r.at,
      valueDrops: r.value_drops,
    }))
  },
  add(core: Core, userId: string, at: string, valueDrops: number): void {
    core.db.prepare('INSERT OR REPLACE INTO earn_points (user_id, at, value_drops) VALUES (?, ?, ?)').run(userId, at, valueDrops)
  },
}
