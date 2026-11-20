'use client'
// Sette Archi's front page: the coffee of the week, then three more items (the grinder is priced above a typical
// card balance, to produce a decline once the card is in).
import { useState } from 'react'
import Link from 'next/link'
import { formatUsd as usd } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { useResource } from '@/lib/hooks'
import { ItemDrawing } from './drawings'
import { SERIF, ShopButton } from './shop-frame'
import { useBasket } from './use-basket'

export function ShopHome() {
  const { api } = useApp()
  const items = useResource(() => api.call('shopItems'), [api])
  const { add } = useBasket()
  const [added, setAdded] = useState<string | null>(null)
  const put = (sku: string) => {
    add(sku)
    setAdded(sku)
    setTimeout(() => setAdded((a) => (a === sku ? null : a)), 1600)
  }

  if (items.error) return <Closed message={items.error} />
  if (!items.data) return <div className="h-[520px] animate-pulse rounded-[6px] bg-[var(--s-line)]/40" aria-busy="true" aria-label="Loading the shop" />

  const [hero, ...rest] = items.data
  return (
    <div>
      <section className="grid items-center gap-8 md:grid-cols-[1fr_1.1fr] md:gap-14">
        <div className="flex justify-center rounded-[6px] border border-[var(--s-line)] bg-[var(--s-card)] p-8 text-[var(--s-ink)]">
          <ItemDrawing sku={hero.sku} className="h-[260px] w-auto md:h-[340px]" />
        </div>
        <div>
          <p className="text-[12px] uppercase tracking-[0.2em] text-[var(--s-olive)]">Coffee of the week</p>
          <h1 className="mt-3 text-[40px] leading-[1.05] md:text-[52px]" style={{ fontFamily: SERIF }}>
            {hero.name}
          </h1>
          {hero.description && <p className="mt-4 max-w-[42ch] text-[17px] leading-relaxed text-[var(--s-muted)]">{hero.description}</p>}
          <p className="tabular mt-6 text-[28px]" style={{ fontFamily: SERIF }}>
            {usd(hero.priceMinor)}
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <ShopButton onClick={() => put(hero.sku)}>Add to basket</ShopButton>
            <Link href="/demo/shop/basket" className="inline-flex min-h-12 items-center px-2 text-[15px] font-[600] underline decoration-[var(--s-line)] underline-offset-4 hover:decoration-[var(--s-ink)]">
              Go to basket
            </Link>
          </div>
          <p className="mt-3 min-h-5 text-[14px] text-[var(--s-olive)]" aria-live="polite">
            {added === hero.sku ? 'Added to your basket.' : ''}
          </p>
        </div>
      </section>

      <section className="mt-16">
        <h2 className="text-[28px]" style={{ fontFamily: SERIF }}>
          More from the roastery
        </h2>
        <ul className="mt-6 grid gap-5 sm:grid-cols-3">
          {rest.map((i) => (
            <li key={i.sku} className="flex flex-col rounded-[6px] border border-[var(--s-line)] bg-[var(--s-card)] p-5">
              <div className="flex h-[170px] items-center justify-center">
                <ItemDrawing sku={i.sku} className="h-[150px] w-auto" />
              </div>
              <h3 className="mt-3 text-[20px] leading-tight" style={{ fontFamily: SERIF }}>
                {i.name}
              </h3>
              {i.description && <p className="mt-1.5 text-[14px] text-[var(--s-muted)]">{i.description}</p>}
              <div className="mt-auto flex items-center justify-between gap-3 pt-5">
                <span className="tabular text-[19px]" style={{ fontFamily: SERIF }}>
                  {usd(i.priceMinor)}
                </span>
                <ShopButton variant="outline" className="min-h-11 px-4 text-[14px]" onClick={() => put(i.sku)} aria-label={`Add ${i.name} to basket`}>
                  {added === i.sku ? 'Added' : 'Add to basket'}
                </ShopButton>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}

export function Closed({ message }: { message?: string }) {
  return (
    <div className="mx-auto max-w-[520px] py-16 text-center">
      <h1 className="text-[32px]" style={{ fontFamily: SERIF }}>
        The shop is closed
      </h1>
      <p className="mt-3 text-[16px] text-[var(--s-muted)]">{message ?? 'Try again later.'}</p>
    </div>
  )
}
