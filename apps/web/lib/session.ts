// The signed-in session: API token, the address it is bound to, and the user once signed up. Kept in localStorage.
import { useSyncExternalStore } from 'react'
import type { User } from '@zecca/contracts'
import { browserStorage, type KV } from './wallet/types'

export type Session = {
  token: string
  address: string
  publicKey: string
  signer: 'mock' | 'privy'
  email?: string
  /** Absent until sign-up is complete. */
  user?: User
}

const KEY = 'zecca.session'

function valid(x: unknown): x is Session {
  const s = x as Session
  return !!s && typeof s.token === 'string' && typeof s.address === 'string' && typeof s.publicKey === 'string' && (s.signer === 'mock' || s.signer === 'privy')
}

export function createSessionStore(storage: KV | null) {
  let current: Session | null = null
  try {
    const raw = storage?.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : null
    current = valid(parsed) ? parsed : null
  } catch {
    current = null
  }
  const listeners = new Set<() => void>()
  const write = (next: Session | null) => {
    current = next
    try {
      if (next) storage?.setItem(KEY, JSON.stringify(next))
      else storage?.removeItem?.(KEY)
    } catch {
      /* blocked storage: keep it in memory */
    }
    listeners.forEach((l) => l())
  }
  return {
    get: () => current,
    set: (s: Session) => write(s),
    update: (patch: Partial<Session>) => current && write({ ...current, ...patch }),
    clear: () => write(null),
    subscribe(l: () => void) {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>

let shared: SessionStore | null = null
/** The app's one session store (browser). */
export function sessionStore(): SessionStore {
  if (!shared) shared = createSessionStore(browserStorage())
  return shared
}

export function useSession(): Session | null {
  return useSyncExternalStore(
    (l) => sessionStore().subscribe(l),
    () => sessionStore().get(),
    () => null,
  )
}
