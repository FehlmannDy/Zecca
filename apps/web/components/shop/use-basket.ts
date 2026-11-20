'use client'
// The basket in localStorage (per browser), shared by every shop page through one tiny store.
import { useSyncExternalStore } from 'react'
import { addToBasket, parseBasket, setQty, type Basket } from './basket'

const KEY = 'settearchi.basket'
const listeners = new Set<() => void>()
let cache: { raw: string | null; basket: Basket } = { raw: null, basket: {} }

function read(): Basket {
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    raw = null
  }
  if (raw !== cache.raw) cache = { raw, basket: parseBasket(raw) }
  return cache.basket
}

function write(b: Basket) {
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
    read,
    () => EMPTY,
  )
  return {
    basket,
    add: (sku: string) => write(addToBasket(read(), sku)),
    set: (sku: string, qty: number) => write(setQty(read(), sku, qty)),
    clear: () => write({}),
  }
}
