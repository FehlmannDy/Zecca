'use client'
import { useState, type DependencyList } from 'react'
import { useResource } from '@/lib/hooks'
import { shopTrouble, type ShopTrouble } from './shop-error'

/** useResource that also keeps why the load failed (closed, missing, or worth a retry). */
export function useShopResource<T>(load: () => Promise<T>, deps: DependencyList) {
  const [trouble, setTrouble] = useState<ShopTrouble>({ kind: 'retry' })
  const r = useResource(
    () =>
      load().catch((e: unknown) => {
        setTrouble(shopTrouble(e))
        throw e
      }),
    deps,
  )
  return { ...r, trouble }
}
