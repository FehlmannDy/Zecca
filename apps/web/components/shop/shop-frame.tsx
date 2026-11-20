'use client'
// Sette Archi's own look (UI.md §5.11): warm paper, espresso ink, terracotta, serif headings. Deliberately not Zecca,
// so that paying here reads as leaving the app. The demo ribbon is on every page, in print too.
import type { CSSProperties, ReactNode } from 'react'
import Link from 'next/link'
import { ShoppingBag } from 'lucide-react'
import { useBasket } from './use-basket'

export const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif'
const SANS = '"Avenir Next", "Segoe UI", "Helvetica Neue", system-ui, sans-serif'

const palette = {
  '--s-bg': '#f7efe2',
  '--s-card': '#fffaf2',
  '--s-ink': '#2b1a12',
  '--s-muted': '#6b5344',
  '--s-line': '#e2d2bb',
  '--s-accent': '#9c4126',
  '--s-olive': '#4f5a2b',
  colorScheme: 'light',
} as CSSProperties

export function ShopFrame({ children }: { children: ReactNode }) {
  const { basket } = useBasket()
  const count = Object.values(basket).reduce((a, b) => a + b, 0)
  return (
    <div className="min-h-svh bg-[var(--s-bg)] text-[var(--s-ink)] [&_:focus-visible]:outline-[var(--s-accent)]" style={{ ...palette, fontFamily: SANS }}>
      <p className="bg-[var(--s-ink)] px-4 py-2 text-center text-[13px] font-[600] tracking-[0.01em] text-[var(--s-bg)]" role="note">
        Demo shop. Nothing is shipped, nothing is charged.
      </p>
      <header className="border-b border-[var(--s-line)]">
        <div className="mx-auto flex h-16 max-w-[1080px] items-center justify-between px-4 sm:px-6">
          <Link href="/demo/shop" className="flex items-baseline gap-2 rounded-[6px]">
            <span className="text-[24px] italic leading-none" style={{ fontFamily: SERIF }}>
              Sette Archi
            </span>
            <span className="hidden text-[12px] uppercase tracking-[0.18em] text-[var(--s-muted)] sm:inline">Torrefazione · Bari</span>
          </Link>
          <Link href="/demo/shop/basket" className="relative inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--s-line)] bg-[var(--s-card)] px-4 text-[14px] font-[600] print:hidden">
            <ShoppingBag className="size-[18px]" aria-hidden="true" />
            Basket
            <span className="tabular min-w-5 rounded-full bg-[var(--s-accent)] px-1.5 text-center text-[12px] font-[700] text-white" aria-label={`${count} items`}>
              {count}
            </span>
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-[1080px] px-4 pb-20 pt-8 sm:px-6">{children}</div>
      <footer className="border-t border-[var(--s-line)] py-8 text-center text-[13px] text-[var(--s-muted)] print:hidden">
        Sette Archi is an invented roaster, made to show paying with Zecca from a website.
      </footer>
    </div>
  )
}

/** Shop buttons: terracotta primary, outline secondary. */
export function ShopButton({ variant = 'primary', className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'outline' }) {
  const v =
    variant === 'primary'
      ? 'bg-[var(--s-accent)] text-white hover:brightness-110 disabled:opacity-45'
      : 'border border-[var(--s-ink)]/25 bg-transparent text-[var(--s-ink)] hover:border-[var(--s-ink)]/60 disabled:opacity-45'
  return <button type="button" className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-[4px] px-6 text-[15px] font-[650] tracking-[0.01em] transition ${v} ${className}`} {...rest} />
}
