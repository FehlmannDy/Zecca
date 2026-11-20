import { describe, expect, it, vi } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import type { User } from '@zecca/contracts'
import { createSessionStore } from './session'

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}
const base = { token: 'mock_abcdefghijklmnop', address: fx.ADDR.ana, publicKey: fx.PUBKEY.ana, signer: 'mock' as const, email: 'ana@example.com' }

describe('session store', () => {
  it('persists, notifies and restores the session', () => {
    const storage = memoryStorage()
    const s = createSessionStore(storage)
    const seen = vi.fn()
    s.subscribe(seen)
    expect(s.get()).toBeNull()
    s.set(base)
    expect(seen).toHaveBeenCalledTimes(1)
    s.update({ user: fx.users.ana as User })
    expect(createSessionStore(storage).get()?.user?.handle).toBe('ana')
    s.clear()
    expect(s.get()).toBeNull()
    expect(createSessionStore(storage).get()).toBeNull()
  })

  it('keeps a stable snapshot between changes (for useSyncExternalStore)', () => {
    const s = createSessionStore(memoryStorage())
    s.set(base)
    expect(s.get()).toBe(s.get())
  })

  it('ignores a corrupted stored value', () => {
    const storage = memoryStorage()
    storage.setItem('zecca.session', '{not json')
    expect(createSessionStore(storage).get()).toBeNull()
    storage.setItem('zecca.session', JSON.stringify({ token: 1 }))
    expect(createSessionStore(storage).get()).toBeNull()
  })
})
