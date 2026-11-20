'use client'
// The basket in localStorage (per browser), shared by every shop page through one tiny store.
import { useSyncExternalStore } from 'react'
import { addToBasket, parseBasket, setQty, type Basket } from './basket'

const KEY = 'settearchi.basket'
const listeners = new Set<() => void>()
let cache: { raw: string | null; basket: Basket } = { raw: null, basket: {} }

export function readBasket(): Basket {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    // Storage blocked: the in-memory basket that writeBasket keeps.
    return cache.basket
  }
  if (raw !== cache.raw) cache = { raw, basket: parseBasket(raw) }
  return cache.basket
}

export function writeBasket(b: Basket) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(b))
  } catch {
    /* storage blocked: the basket lives until reload */
    cache = { raw: JSON.stringify(b), basket: b }
  }
  listeners.forEach((l) => l())
}

const EMPTY: Basket = {}

export function useBasket() {
  const basket = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      const onStorage = (e: StorageEvent) => e.key === KEY && l()
      window.addEventListener('storage', onStorage)
      return () => {
        listeners.delete(l)
        window.removeEventListener('storage', onStorage)
      }
    },
    readBasket,
    () => EMPTY,
  )
  return {
    basket,
    add: (sku: string) => writeBasket(addToBasket(readBasket(), sku)),
    set: (sku: string, qty: number) => writeBasket(setQty(readBasket(), sku, qty)),
    clear: () => writeBasket({}),
  }
}
