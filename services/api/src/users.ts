// Users: rows, the User and PublicProfile shapes, lookups.
import type { PublicProfile, Role, User } from '@zecca/contracts'
import type { Core } from './core'

export type UserRow = {
  id: string
  address: string
  publicKey: string
  handle: string
  displayName: string
  roles: Role[]
  email?: string
  phone?: string
  tier: 0 | 1
  businessName?: string
  feeBps?: number
  privyUserId?: string
  status: 'pending' | 'active'
  createdAt: string
  activatedAt?: string
}

type Raw = {
  id: string
  address: string
  public_key: string
  handle: string
  display_name: string
  roles: string
  email: string | null
  phone: string | null
  tier: number
  business_name: string | null
  fee_bps: number | null
  privy_user_id: string | null
  status: 'pending' | 'active'
  created_at: string
  activated_at: string | null
}

const fromRaw = (r: Raw | undefined): UserRow | undefined =>
  r && {
    id: r.id,
    address: r.address,
    publicKey: r.public_key,
    handle: r.handle,
    displayName: r.display_name,
    roles: r.roles.split(',') as Role[],
    email: r.email ?? undefined,
    phone: r.phone ?? undefined,
    tier: r.tier === 1 ? 1 : 0,
    businessName: r.business_name ?? undefined,
    feeBps: r.fee_bps ?? undefined,
    privyUserId: r.privy_user_id ?? undefined,
    status: r.status,
    createdAt: r.created_at,
    activatedAt: r.activated_at ?? undefined,
  }

export function toUser(u: UserRow): User {
  return {
    id: u.id,
    role: u.roles,
    handle: u.handle,
    displayName: u.displayName,
    address: u.address,
    ...(u.email ? { email: u.email } : {}),
    ...(u.phone ? { phone: u.phone } : {}),
    tier: u.tier,
    createdAt: u.activatedAt ?? u.createdAt,
    ...(u.roles.includes('merchant') && u.businessName ? { merchant: { businessName: u.businessName, feeBps: u.feeBps ?? 0 } } : {}),
  }
}

export function toProfile(u: UserRow): PublicProfile {
  const isMerchant = u.roles.includes('merchant')
  return { id: u.id, handle: u.handle, displayName: isMerchant && u.businessName ? u.businessName : u.displayName, isMerchant }
}

export const users = {
  byId: (core: Core, id: string) => fromRaw(core.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Raw | undefined),
  byAddress: (core: Core, address: string) =>
    fromRaw(core.db.prepare('SELECT * FROM users WHERE address = ?').get(address) as Raw | undefined),
  byHandle: (core: Core, handle: string) =>
    fromRaw(core.db.prepare('SELECT * FROM users WHERE handle = ?').get(handle.toLowerCase()) as Raw | undefined),
  activeByEmail: (core: Core, email: string) =>
    fromRaw(core.db.prepare("SELECT * FROM users WHERE lower(email) = ? AND status = 'active'").get(email.toLowerCase()) as Raw | undefined),
  activeByPhone: (core: Core, phone: string) =>
    fromRaw(core.db.prepare("SELECT * FROM users WHERE phone = ? AND status = 'active'").get(phone) as Raw | undefined),
  byPrivyId: (core: Core, privyUserId: string) =>
    fromRaw(core.db.prepare('SELECT * FROM users WHERE privy_user_id = ?').get(privyUserId) as Raw | undefined),

  insert(core: Core, u: UserRow): void {
    core.db
      .prepare(
        `INSERT INTO users (id, address, public_key, handle, display_name, roles, email, phone, tier, business_name, fee_bps, privy_user_id, status, created_at, activated_at)
         VALUES (@id, @address, @publicKey, @handle, @displayName, @roles, @email, @phone, @tier, @businessName, @feeBps, @privyUserId, @status, @createdAt, @activatedAt)`,
      )
      .run({
        ...u,
        roles: u.roles.join(','),
        email: u.email ?? null,
        phone: u.phone ?? null,
        businessName: u.businessName ?? null,
        feeBps: u.feeBps ?? null,
        privyUserId: u.privyUserId ?? null,
        activatedAt: u.activatedAt ?? null,
      })
  },
  remove(core: Core, id: string): void {
    core.db.prepare('DELETE FROM users WHERE id = ?').run(id)
  },
  activate(core: Core, id: string, at: string): void {
    core.db.prepare("UPDATE users SET status = 'active', activated_at = ? WHERE id = ?").run(at, id)
  },
  setTier(core: Core, id: string, tier: 0 | 1): void {
    core.db.prepare('UPDATE users SET tier = ? WHERE id = ?').run(tier, id)
  },
  active(core: Core): UserRow[] {
    return (core.db.prepare("SELECT * FROM users WHERE status = 'active'").all() as Raw[]).map((r) => fromRaw(r)!)
  },
}
