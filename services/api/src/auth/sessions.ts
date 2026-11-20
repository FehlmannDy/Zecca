// Opaque random session tokens, stored hashed, bound to one { address, publicKey }.
import { createHash, randomBytes } from 'node:crypto'
import type { Core } from '../core'
import { users, type UserRow } from '../users'

export type Session = {
  tokenHash: string
  address: string
  publicKey: string
  privyUserId?: string
  /** The Privy account's email (Privy verified it). Never set for the test sign-in. */
  email?: string
  /** The user with this address (pending during sign-up, then active). */
  user?: UserRow
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex')

export function createSession(core: Core, s: { address: string; publicKey: string; privyUserId?: string; email?: string }): string {
  const token = randomBytes(32).toString('base64url')
  const now = core.now()
  core.db
    .prepare('INSERT INTO sessions (token_hash, address, public_key, privy_user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(hashToken(token), s.address, s.publicKey.toUpperCase(), s.privyUserId ?? null, s.email ?? null, core.iso(now), core.iso(now + core.settings.sessionTtlMs))
  return token
}

export function lookupSession(core: Core, token: string): Session | undefined {
  if (!token || token.length < 16 || token.length > 200) return undefined
  const row = core.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
    | { token_hash: string; address: string; public_key: string; privy_user_id: string | null; email: string | null; expires_at: string }
    | undefined
  if (!row || Date.parse(row.expires_at) <= core.now()) return undefined
  const user = users.byAddress(core, row.address)
  return {
    tokenHash: row.token_hash,
    address: row.address,
    publicKey: row.public_key,
    privyUserId: row.privy_user_id ?? undefined,
    email: row.email ?? undefined,
    // A user row bound to another key is not this session's user.
    user: user && user.publicKey.toUpperCase() === row.public_key ? user : undefined,
  }
}
