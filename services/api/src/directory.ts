// Directory: handle availability (public), resolve a handle / email / phone / address, contacts.
import type { Hono } from 'hono'
import { Handle, XrplAddress, type PublicProfile } from '@zecca/contracts'
import type { Core } from './core'
import { COPY } from './errors'
import { mount } from './http'
import { toProfile, users, type UserRow } from './users'

/** A pending sign-up holds its handle this long; after that another address may take it. */
export const PENDING_HOLD_MS = 30 * 60_000

export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'zecca', 'support', 'help', 'pool', 'sponsor', 'issuer', 'relayer', 'root', 'system', 'api',
  'www', 'mail', 'security', 'official', 'team', 'staff', 'merchant', 'merchants', 'settings', 'pay', 'null', 'undefined',
])

/** Whether `handle` can be taken by `forAddress`. A stale pending sign-up of another address does not hold it. */
export function handleStatus(core: Core, handle: string, forAddress?: string): { available: boolean; reason?: string; staleHolderId?: string } {
  const h = handle.trim().replace(/^@/, '').toLowerCase()
  const parsed = Handle.safeParse(h)
  if (!parsed.success) return { available: false, reason: parsed.error.issues[0]?.message ?? COPY.handleTaken }
  if (RESERVED_HANDLES.has(h)) return { available: false, reason: COPY.handleTaken }
  const holder = users.byHandle(core, h)
  if (!holder || holder.address === forAddress) return { available: true }
  if (holder.status === 'pending' && core.now() - Date.parse(holder.createdAt) > PENDING_HOLD_MS) return { available: true, staleHolderId: holder.id }
  return { available: false, reason: COPY.handleTaken }
}

const PHONE = /^\+?[0-9][0-9 ().-]{3,19}$/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const normalizePhone = (p: string) => p.replace(/[^0-9+]/g, '')

export function resolveQuery(core: Core, q: string): { kind: 'zecca'; profile: PublicProfile } | { kind: 'external'; address: string } | { kind: 'unknown' } {
  const s = q.trim()
  let u: UserRow | undefined
  if (XrplAddress.safeParse(s).success) {
    u = users.byAddress(core, s)
    if (u?.status === 'active') return { kind: 'zecca', profile: toProfile(u) }
    return { kind: 'external', address: s }
  }
  if (EMAIL.test(s)) u = users.activeByEmail(core, s)
  else if (PHONE.test(s) && /\d{4}/.test(s.replace(/\D/g, ''))) u = users.activeByPhone(core, normalizePhone(s))
  else u = users.byHandle(core, s.replace(/^@/, ''))
  return u?.status === 'active' ? { kind: 'zecca', profile: toProfile(u) } : { kind: 'unknown' }
}

/** People this user has paid or been paid by, most recent first. */
export function contactsOf(core: Core, userId: string): PublicProfile[] {
  const rows = core.db
    .prepare(
      `SELECT cp, MAX(at) AS last FROM (
         SELECT to_user_id AS cp, created_at AS at FROM intents WHERE from_user_id = @u AND kind IN ('p2p', 'merchant') AND submitted_at IS NOT NULL AND status NOT IN ('failed', 'expired')
         UNION ALL
         SELECT from_user_id AS cp, created_at AS at FROM intents WHERE to_user_id = @u AND kind IN ('p2p', 'merchant') AND status IN ('received', 'paid_out')
       ) WHERE cp IS NOT NULL AND cp != @u GROUP BY cp ORDER BY last DESC LIMIT 50`,
    )
    .all({ u: userId }) as Array<{ cp: string }>
  return rows.flatMap((r) => {
    const u = users.byId(core, r.cp)
    return u?.status === 'active' ? [toProfile(u)] : []
  })
}

export function mountDirectory(app: Hono, core: Core): void {
  mount(app, core, 'handleAvailable', ({ query }) => {
    const r = handleStatus(core, query.handle)
    return r.available ? { available: true } : { available: false, ...(r.reason ? { reason: r.reason } : {}) }
  })
  mount(app, core, 'resolve', ({ query }) => resolveQuery(core, query.q))
  mount(app, core, 'contacts', ({ user }) => contactsOf(core, user!.id))
}
