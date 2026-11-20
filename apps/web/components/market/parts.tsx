'use client'
// Small market pieces: sparkline, change badge, the locked state for unverified accounts, the price's date line.
import Link from 'next/link'
import { ArrowDownRight, ArrowUpRight, Lock, Minus } from 'lucide-react'
import type { MarketAsset } from '@zecca/contracts'
import { Panel } from '@/components/zecca/glass'
import { useApp } from '@/lib/app'
import { cn } from '@/lib/cn'
import { changeText, priceTime, sparkPath } from './market-model'

export function Sparkline({ values, className, label }: { values: number[]; className?: string; label?: string }) {
  const d = sparkPath(values, 96, 28)
  if (!d) return <span className={cn('inline-block h-7 w-24', className)} aria-hidden="true" />
  return (
    <svg viewBox="0 0 96 28" preserveAspectRatio="none" className={cn('h-7 w-24 overflow-visible text-ink/70', className)} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Change({ pct, className }: { pct?: number; className?: string }) {
  const c = changeText(pct)
  if (!c) return null
  const Icon = c.dir === 'up' ? ArrowUpRight : c.dir === 'down' ? ArrowDownRight : Minus
  return (
    <span className={cn('tabular inline-flex items-center gap-0.5 text-[13px] font-[650]', c.dir === 'up' ? 'text-in' : c.dir === 'down' ? 'text-alert' : 'text-muted', className)}>
      <Icon className="size-3.5" aria-hidden="true" />
      <span aria-hidden="true">{c.text}</span>
      <span className="sr-only">{c.spoken} since the previous close</span>
    </span>
  )
}

/** "Price at Nov 20, 21:59 · COMEX via Yahoo Finance". The source says when it is a fixture. */
export function PriceDate({ asset, className }: { asset: Pick<MarketAsset, 'priceAt' | 'priceSource'>; className?: string }) {
  return (
    <p className={cn('text-[12.5px] text-muted', className)}>
      Price at <time dateTime={asset.priceAt}>{priceTime(asset.priceAt)}</time> · {asset.priceSource}
    </p>
  )
}

export function Locked({ className }: { className?: string }) {
  const { config } = useApp()
  return (
    <Panel className={cn('flex flex-col items-start gap-3', className)}>
      <span className="grid size-10 place-items-center rounded-full border border-line bg-surface" aria-hidden="true">
        <Lock className="size-[18px]" />
      </span>
      <p className="text-[17px] font-[700] tracking-[-0.01em]">Verify your identity to trade metals.</p>
      <p className="text-[14.5px] text-muted">Buying and selling gold, silver and palladium is for verified accounts. You can still watch the prices.</p>
      {config?.features.identity && (
        <Link href="/app/identity" className="inline-flex min-h-12 items-center rounded-[14px] bg-ink px-5 text-[15px] font-[680] text-paper hover:opacity-90">
          Verify your identity
        </Link>
      )}
    </Panel>
  )
}
