// The "Personal | Business" switch in the header of both spaces. Only an account with a business sees it.
import type { User } from '@zecca/contracts'

export type Space = 'personal' | 'business'
export type SpaceTab = { space: Space; href: string; label: string; current: boolean }

export function spaceOf(pathname: string): Space {
  return pathname === '/merchant' || pathname.startsWith('/merchant/') ? 'business' : 'personal'
}

/** True for an account with a business: only it has two spaces to switch between. */
export function hasSpaceSwitch(user: Pick<User, 'role'> | null | undefined): boolean {
  return !!user?.role.includes('merchant')
}

/** The two tabs, or null when there is nothing to switch to. */
export function spaceTabs(user: Pick<User, 'role'> | null | undefined, pathname: string): SpaceTab[] | null {
  if (!hasSpaceSwitch(user)) return null
  const here = spaceOf(pathname)
  return [
    { space: 'personal', href: '/app', label: 'Personal', current: here === 'personal' },
    { space: 'business', href: '/merchant', label: 'Business', current: here === 'business' },
  ]
}
