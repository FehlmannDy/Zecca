// Identity sessions. Own table (created here, not in the shared migrations). Keeps only the three facts and over18.
import type { Core } from '../../core'

export type SessionStatus = 'pending' | 'verified' | 'rejected' | 'error' | 'accepted'

export type IdentitySessionRow = {
  id: string
  userId: string
  mode: 'live' | 'mock'
  transactionId: string
  link: string
  status: SessionStatus
  message?: string
  givenName?: string
  familyName?: string
  birthDate?: string
  over18?: boolean
  /** Hash of the CredentialCreate, or 'existing' when the ledger already held it (tecDUPLICATE). */
  credentialHash?: string
  prepareId?: string
  acceptedHash?: string
  createdAt: string
  expiresAt: string
  verifiedAt?: string
}

type Raw = {
  id: string
  user_id: string
  mode: 'live' | 'mock'
  transaction_id: string
  link: string
  status: SessionStatus
  message: string | null
  given_name: string | null
  family_name: string | null
  birth_date: string | null
  over18: number | null
  credential_hash: string | null
  prepare_id: string | null
  accepted_hash: string | null
  created_at: string
  expires_at: string
  verified_at: string | null
}

const fromRaw = (r: Raw): IdentitySessionRow => ({
  id: r.id,
  userId: r.user_id,
  mode: r.mode,
  transactionId: r.transaction_id,
  link: r.link,
  status: r.status,
  message: r.message ?? undefined,
  givenName: r.given_name ?? undefined,
  familyName: r.family_name ?? undefined,
  birthDate: r.birth_date ?? undefined,
  over18: r.over18 === null ? undefined : r.over18 === 1,
  credentialHash: r.credential_hash ?? undefined,
  prepareId: r.prepare_id ?? undefined,
  acceptedHash: r.accepted_hash ?? undefined,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  verifiedAt: r.verified_at ?? undefined,
})

const ready = new WeakSet<object>()
export function ensureSchema(core: Core): void {
  if (ready.has(core.db)) return
  core.db.exec(`
    CREATE TABLE IF NOT EXISTS identity_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('live', 'mock')),
      transaction_id TEXT NOT NULL,
      link TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'verified', 'rejected', 'error', 'accepted')),
      message TEXT,
      given_name TEXT,
      family_name TEXT,
      birth_date TEXT,
      over18 INTEGER CHECK (over18 IN (0, 1)),
      credential_hash TEXT,
      prepare_id TEXT UNIQUE,
      accepted_hash TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      verified_at TEXT
    );
    CREATE INDEX IF NOT EXISTS identity_sessions_user ON identity_sessions (user_id, created_at);
  `)
  ready.add(core.db)
}

export function insertSession(core: Core, s: Pick<IdentitySessionRow, 'id' | 'userId' | 'mode' | 'transactionId' | 'link' | 'createdAt' | 'expiresAt'>): void {
  core.db
    .prepare(
      `INSERT INTO identity_sessions (id, user_id, mode, transaction_id, link, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(s.id, s.userId, s.mode, s.transactionId, s.link, s.createdAt, s.expiresAt)
}

export function sessionById(core: Core, id: string): IdentitySessionRow | undefined {
  ensureSchema(core)
  const r = core.db.prepare('SELECT * FROM identity_sessions WHERE id = ?').get(id) as Raw | undefined
  return r && fromRaw(r)
}

export function sessionByPrepareId(core: Core, prepareId: string): IdentitySessionRow | undefined {
  ensureSchema(core)
  const r = core.db.prepare('SELECT * FROM identity_sessions WHERE prepare_id = ?').get(prepareId) as Raw | undefined
  return r && fromRaw(r)
}

/** Ends a pending session (rejected, error). Only a pending row changes. */
export function endSession(core: Core, id: string, status: 'rejected' | 'error', message: string): void {
  core.db.prepare("UPDATE identity_sessions SET status = ?, message = ? WHERE id = ? AND status = 'pending'").run(status, message, id)
}

export function markVerified(core: Core, id: string, v: { givenName: string; familyName: string; birthDate: string; over18: boolean }, at: string): void {
  core.db
    .prepare("UPDATE identity_sessions SET status = 'verified', given_name = ?, family_name = ?, birth_date = ?, over18 = ?, verified_at = ? WHERE id = ? AND status = 'pending'")
    .run(v.givenName, v.familyName, v.birthDate, v.over18 ? 1 : 0, at, id)
}

export function setCredentialHash(core: Core, id: string, hash: string): void {
  core.db.prepare('UPDATE identity_sessions SET credential_hash = ? WHERE id = ?').run(hash, id)
}

export function setPrepareId(core: Core, id: string, prepareId: string): void {
  core.db.prepare('UPDATE identity_sessions SET prepare_id = ? WHERE id = ?').run(prepareId, id)
}

export function markAccepted(core: Core, id: string, hash: string): void {
  core.db.prepare("UPDATE identity_sessions SET status = 'accepted', accepted_hash = ? WHERE id = ? AND status = 'verified'").run(hash, id)
}
