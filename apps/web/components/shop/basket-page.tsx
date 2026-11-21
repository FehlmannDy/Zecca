'use client'
// The basket: quantities, total, "Checkout" (creates the order and its payment request, then the checkout page).
import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Minus, Plus, Trash2 } from 'lucide-react'
import { formatUsd } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { isApiError } from '@/lib/api'
import { basketLines, toOrderItems } from './basket'
import { ItemDrawing } from './drawings'
import { SERIF, ShopButton } from './shop-frame'
import { ShopUnavailable } from './shop-home'
import { useBasket } from './use-basket'
import { useShopResource } from './use-shop-resource'

export function BasketPage() {
  const { api } = useApp()
  const router = useRouter()
  const items = useShopResource(() => api.call('shopItems'), [api])
  const { basket, set } = useBasket()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  if (items.error) return <ShopUnavailable trouble={items.trouble} onRetry={items.reload} />
  if (!items.data) return <div className="h-64 animate-pulse rounded-[6px] bg-[var(--s-line)]/40" aria-busy="true" aria-label="Loading your basket" />
  const { lines, totalMinor } = basketLines(basket, items.data)

  async function checkout() {
    setBusy(true)
    setError('')
    try {
      const o = await api.call('shopOrderCreate', { body: { items: toOrderItems(basket) } })
      router.push(`/demo/shop/checkout/${encodeURIComponent(o.orderId)}`)
    } catch (e) {
      setError(isApiError(e) || e instanceof Error ? e.message : 'Something went wrong. Try again.')
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[760px]">
      <h1 className="text-[36px]" style={{ fontFamily: SERIF }}>
        Your basket
      </h1>
      {lines.length === 0 ? (
        <div className="mt-8 rounded-[6px] border border-[var(--s-line)] bg-[var(--s-card)] p-10 text-center">
          <p className="text-[17px]">Your basket is empty.</p>
          <Link href="/demo/shop" className="mt-5 inline-flex min-h-12 items-center rounded-[4px] bg-[var(--s-accent)] px-6 text-[15px] font-[650] text-white">
            Browse the coffee
          </Link>
        </div>
      ) : (
        <>
          <ul className="mt-6 divide-y divide-[var(--s-line)] border-y border-[var(--s-line)]">
            {lines.map((l) => (
              <li key={l.sku} className="flex items-center gap-4 py-4">
                <span className="grid size-16 shrink-0 place-items-center rounded-[4px] bg-[var(--s-card)]">
                  <ItemDrawing sku={l.sku} className="h-14 w-auto" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[17px] leading-tight" style={{ fontFamily: SERIF }}>
                    {l.name}
                  </p>
                  <p className="tabular mt-1 text-[14px] text-[var(--s-muted)]">{formatUsd(l.priceMinor)} each</p>
                  <div className="mt-2 inline-flex items-center rounded-[4px] border border-[var(--s-line)]">
                    <button type="button" className="grid size-11 place-items-center" onClick={() => set(l.sku, l.qty - 1)} aria-label={`One less ${l.name}`}>
                      {l.qty === 1 ? <Trash2 className="size-4" aria-hidden="true" /> : <Minus className="size-4" aria-hidden="true" />}
                    </button>
                    <span className="tabular min-w-8 text-center text-[15px] font-[650]" aria-label={`Quantity ${l.qty}`}>
                      {l.qty}
                    </span>
                    <button type="button" className="grid size-11 place-items-center disabled:opacity-40" onClick={() => set(l.sku, l.qty + 1)} disabled={l.qty >= 20} aria-label={`One more ${l.name}`}>
                      <Plus className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <span className="tabular text-[17px] font-[650]">{formatUsd(l.lineMinor)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex items-baseline justify-between">
            <span className="text-[15px] text-[var(--s-muted)]">Total · free delivery</span>
            <span className="tabular text-[28px]" style={{ fontFamily: SERIF }}>
              {formatUsd(totalMinor)}
            </span>
          </div>
          <div className="mt-6 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-end">
            <Link href="/demo/shop" className="inline-flex min-h-12 items-center justify-center px-4 text-[15px] font-[600] underline decoration-[var(--s-line)] underline-offset-4">
              Keep shopping
            </Link>
            <ShopButton onClick={checkout} disabled={busy} aria-busy={busy}>
              {busy ? 'One moment…' : 'Checkout'}
            </ShopButton>
          </div>
          <p className="mt-3 min-h-5 text-right text-[14px] text-[var(--s-accent)]" role="alert">
            {error}
          </p>
        </>
      )}
    </div>
  )
}
