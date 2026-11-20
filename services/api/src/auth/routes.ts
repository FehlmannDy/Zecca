// POST /v1/auth/nonce and POST /v1/auth/session (DECISIONS #4).
import { randomBytes } from 'node:crypto'
import type { Hono } from 'hono'
import * as rk from 'ripple-keypairs'
import { verifyMessage } from '@zecca/xrpl-core/signer'
import type { Core } from '../core'
import { Err } from '../errors'
import { mount } from '../http'
import { toUser, users } from '../users'
import { createSession } from './sessions'

const keyMatches = (address: string, publicKey: string) => {
  try {
    return rk.deriveAddress(publicKey) === address
  } catch {
    return false
  }
}

/** SIGNER_MODE=mock: only the nonce shape. privy: only the Privy shape, unless DEMO_MODE=1 (then both). */
const nonceAllowed = (core: Core) => core.settings.signerMode === 'mock' || core.settings.demoMode
const privyAllowed = (core: Core) => core.settings.signerMode === 'privy'

export function mountAuth(app: Hono, core: Core): void {
  mount(app, core, 'authNonce', ({ body }) => {
    if (!nonceAllowed(core)) throw Err.forbidden('Sign in with your email.')
    if (!keyMatches(body.address, body.publicKey)) throw Err.badRequest("That key doesn't belong to this address.")
    const nonce = randomBytes(24).toString('hex')
    const now = core.now()
    const expiresAt = core.iso(now + core.settings.nonceTtlMs)
    const message = `Sign in to Zecca\nAddress: ${body.address}\nNonce: ${nonce}\nIssued at: ${core.iso(now)}`
    core.db
      .prepare('INSERT INTO nonces (nonce, address, public_key, message, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(nonce, body.address, body.publicKey.toUpperCase(), message, expiresAt)
    return { nonce, message, expiresAt }
  })

  mount(app, core, 'authSession', async ({ body }) => {
    const publicKey = body.publicKey.toUpperCase()
    if (!keyMatches(body.address, publicKey)) throw Err.unauthorized("Sign-in failed: that key doesn't belong to this address.")
    let privyUserId: string | undefined

    if ('privyToken' in body) {
      if (!privyAllowed(core)) throw Err.badRequest('Email sign-in is off here. Use the test sign-in.')
      if (!core.privy) throw Err.upstream("Email sign-in isn't configured on this server.")
      try {
        privyUserId = (await core.privy.verify(body.privyToken, body.address)).privyUserId
      } catch (e) {
        core.log.warn(`[auth] privy session refused: ${(e as Error).message}`)
        throw Err.unauthorized('Sign-in failed. Sign in with your email again.')
      }
    } else {
      if (!nonceAllowed(core)) throw Err.badRequest('Sign in with your email.')
      const row = core.db.prepare('SELECT * FROM nonces WHERE nonce = ?').get(body.nonce) as
        | { nonce: string; address: string; public_key: string; message: string; expires_at: string; used_at: string | null }
        | undefined
      const fail = () => Err.unauthorized('Sign-in failed. Try again.')
      if (!row || row.used_at || row.address !== body.address || row.public_key !== publicKey) throw fail()
      if (Date.parse(row.expires_at) <= core.now()) throw Err.unauthorized('That sign-in took too long. Try again.')
      if (!verifyMessage(row.message, body.signature, publicKey)) throw fail()
      // Single use, atomically.
      if (core.db.prepare('UPDATE nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL').run(core.iso(), row.nonce).changes !== 1) throw fail()
    }

    const existing = users.byAddress(core, body.address)
    if (existing && existing.publicKey.toUpperCase() !== publicKey) throw Err.unauthorized('Sign-in failed. Try again.')
    if (existing?.privyUserId && privyUserId && existing.privyUserId !== privyUserId) throw Err.unauthorized('Sign-in failed. Try again.')

    const token = createSession(core, { address: body.address, publicKey, privyUserId })
    return { token, ...(existing?.status === 'active' ? { user: toUser(existing) } : {}) }
  })

  mount(app, core, 'me', ({ user }) => toUser(user!))
}
