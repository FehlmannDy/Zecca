import { afterEach, describe, expect, it } from 'vitest'
import { readBasket, writeBasket } from './use-basket'

const g = globalThis as { window?: unknown }

describe('basket store', () => {
  afterEach(() => {
    delete g.window
  })

  it('with site data blocked (localStorage throws), the basket still holds what was added until reload', () => {
    const blocked = () => {
      throw new DOMException('blocked', 'SecurityError')
    }
    g.window = { localStorage: { getItem: blocked, setItem: blocked } }
    writeBasket({ 'guji-250': 2 })
    expect(readBasket()).toEqual({ 'guji-250': 2 })
    // A stable snapshot for useSyncExternalStore.
    expect(readBasket()).toBe(readBasket())
  })

  it('with storage, reads back what was written', () => {
    const m = new Map<string, string>()
    g.window = { localStorage: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } }
    writeBasket({ 'moka-3': 1 })
    expect(readBasket()).toEqual({ 'moka-3': 1 })
  })
})
