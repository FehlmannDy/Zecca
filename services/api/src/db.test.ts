import { describe, expect, it } from 'vitest'
import { openDb, SCHEMA_VERSION } from './db'

describe('db', () => {
  it('creates every table on a fresh database and records the schema version', () => {
    const db = openDb(':memory:')
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name)
    for (const t of ['users', 'sessions', 'nonces', 'prepared_txs', 'intents', 'payment_requests', 'activities', 'balances', 'effects']) {
      expect(tables).toContain(t)
    }
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('is safe to open twice (migrations run once)', () => {
    const db = openDb(':memory:')
    expect(() => openDb(db)).not.toThrow()
    expect(db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
  })

  it('stores amounts as integers and refuses non-integer amounts', () => {
    const db = openDb(':memory:')
    db.prepare("INSERT INTO balances (user_id, available_minor, pending_minor, updated_at) VALUES ('u1', 150, 0, 'now')").run()
    expect(() => db.prepare("INSERT INTO balances (user_id, available_minor, pending_minor, updated_at) VALUES ('u2', 1.5, 0, 'now')").run()).toThrow()
    expect(() => db.prepare("INSERT INTO balances (user_id, available_minor, pending_minor, updated_at) VALUES ('u3', -1, 0, 'now')").run()).toThrow()
  })

  it('enforces one user per address and per handle', () => {
    const db = openDb(':memory:')
    const ins = db.prepare(
      "INSERT INTO users (id, address, public_key, handle, display_name, roles, tier, status, created_at) VALUES (?, ?, 'PK', ?, 'N', 'user', 0, 'active', 'now')",
    )
    ins.run('u1', 'rA', 'ana')
    expect(() => ins.run('u2', 'rA', 'bob')).toThrow()
    expect(() => ins.run('u3', 'rB', 'ana')).toThrow()
  })
})
