// Till tables (created by the connector): pairing codes and till tokens, both stored as SHA-256 hashes, and which till
// made which payment request.
import { createHash, randomBytes, randomInt } from 'node:crypto'
import type { Core } from '../../core'
import type { ResponseOf } from '@zecca/contracts'
import { CODE_ALPHABET, CODE_LENGTH, PAIRING_TTL_MS } from './schemas'

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function ensureTillTables(core: Core): void {
  core.db.exec(`
    CREATE TABLE IF NOT EXISTS till_pairings (
      code_hash TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS till_pairings_merchant ON till_pairings (merchant_id);
    CREATE TABLE IF NOT EXISTS tills (
      id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS tills_merchant ON tills (merchant_id, created_at);
    CREATE TABLE IF NOT EXISTS till_charges (
      request_id TEXT PRIMARY KEY,
      till_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `)
}

function newCode(): string {
  let s = ''
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return s
}

/** A fresh single-use code for the merchant; their previous unused codes stop working. */
export function createPairing(core: Core, merchantId: string): { code: string; expiresAt: string } {
  const code = newCode()
  const expiresAt = core.iso(core.now() + PAIRING_TTL_MS)
  core.db.transaction(() => {
    core.db.prepare('DELETE FROM till_pairings WHERE merchant_id = ? AND used_at IS NULL').run(merchantId)
    core.db
      .prepare('INSERT INTO till_pairings (code_hash, merchant_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run(sha256(code), merchantId, expiresAt, core.iso())
  })()
  return { code, expiresAt }
}

/** Uses the code (once) and creates the till. Returns undefined for an unknown, used or expired code. */
export function redeemPairing(core: Core, code: string, name: string): { tillId: string; token: string; merchantId: string } | undefined {
  return core.db.transaction(() => {
    const now = core.iso()
    const row = core.db
      .prepare('SELECT merchant_id FROM till_pairings WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(sha256(code), now) as { merchant_id: string } | undefined
    if (!row) return undefined
    core.db.prepare('UPDATE till_pairings SET used_at = ? WHERE code_hash = ?').run(now, sha256(code))
    const tillId = core.id('till')
    const token = `till_${randomBytes(32).toString('base64url')}`
    core.db
      .prepare('INSERT INTO tills (id, merchant_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(tillId, row.merchant_id, name, sha256(token), now)
    return { tillId, token, merchantId: row.merchant_id }
  })()
}

export type TillRow = { id: string; merchantId: string; name: string }

/** The paired (not revoked) till holding this token; marks it seen. Found by the SHA-256 of the token (the secret itself
 * is never compared, so the lookup time says nothing about it), as sessions are. */
export function tillByToken(core: Core, token: string): TillRow | undefined {
  if (!token.startsWith('till_') || token.length > 200) return undefined
  const r = core.db.prepare('SELECT id, merchant_id, name FROM tills WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) as
    | { id: string; merchant_id: string; name: string }
    | undefined
  if (!r) return undefined
  core.db.prepare('UPDATE tills SET last_seen_at = ? WHERE id = ?').run(core.iso(), r.id)
  return { id: r.id, merchantId: r.merchant_id, name: r.name }
}

export function listTills(core: Core, merchantId: string): ResponseOf<'tillList'>['items'] {
  const rows = core.db
    .prepare('SELECT id, name, created_at, last_seen_at FROM tills WHERE merchant_id = ? AND revoked_at IS NULL ORDER BY created_at DESC, id DESC')
    .all(merchantId) as Array<{ id: string; name: string; created_at: string; last_seen_at: string | null }>
  return rows.map((r) => ({ id: r.id, name: r.name, pairedAt: r.created_at, ...(r.last_seen_at ? { lastSeenAt: r.last_seen_at } : {}) }))
}

/** True when the merchant's till was revoked by this call. */
export function revokeTill(core: Core, merchantId: string, tillId: string): boolean {
  return (
    core.db.prepare('UPDATE tills SET revoked_at = ? WHERE id = ? AND merchant_id = ? AND revoked_at IS NULL').run(core.iso(), tillId, merchantId).changes === 1
  )
}

export function recordCharge(core: Core, requestId: string, tillId: string): void {
  core.db.prepare('INSERT INTO till_charges (request_id, till_id, created_at) VALUES (?, ?, ?)').run(requestId, tillId, core.iso())
}

export function isTillCharge(core: Core, requestId: string, tillId: string): boolean {
  return !!core.db.prepare('SELECT 1 FROM till_charges WHERE request_id = ? AND till_id = ?').get(requestId, tillId)
}
