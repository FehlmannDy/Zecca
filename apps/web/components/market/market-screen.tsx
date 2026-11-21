'use client'
// Market (UI.md §5.10): three rows, Gold, Silver, Palladium, with the price per gram, a small sparkline and the
// price's time; the holdings in grams; the locked state for unverified accounts. Each row opens the asset page.
import Link from 'next/link'
import { ChevronRight, RotateCw } from 'lucide-react'
import { formatUsd, type Holding, type MarketAsset } from '@zecca/contracts'
import { Button, Skeleton } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { useApp } from '@/lib/app'
import { useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { gramsText } from './market-model'
import { Change, Locked, PriceDate, Sparkline } from './parts'

export function MarketScreen() {
  const { api, config } = useApp()
  const session = useSession()
  const on = !!config?.features.market
  const assets = useResource(() => api.call('marketAssets'), [api], on)
  const holdings = useResource(() => api.call('marketHoldings'), [api], on)
  const verified = session?.user?.tier === 1

  if (config && !on) return <NotAvailable />

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <div>
        <h1 className="text-[26px] font-[740] tracking-[-0.025em]">Metals</h1>
        <p className="mt-1 text-[14.5px] text-muted">Gold, silver and palladium, by the gram. What you hold is visible on the public ledger; the dollars you pay stay private.</p>
      </div>

      {session?.user && !verified && <Locked />}

      <Panel className="p-0">
        <ul className="divide-y divide-line" aria-busy={assets.loading || undefined}>
          {assets.loading || !config
            ? [0, 1, 2].map((i) => <RowSkeleton key={i} />)
            : assets.data?.map((a) => <AssetRow key={a.symbol} asset={a} holding={holdings.data?.find((h) => h.symbol === a.symbol)} />)}
        </ul>
        {assets.error && (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <p className="text-[15px] text-alert" role="alert">
              {assets.error}
            </p>
            <Button variant="secondary" onClick={assets.reload}>
              <RotateCw className="size-4" aria-hidden="true" /> Try again
            </Button>
          </div>
        )}
      </Panel>

      {assets.data && holdings.data && <HoldingsSummary holdings={holdings.data} />}
      {assets.data?.[0] && <PriceDate asset={assets.data[0]} className="px-1" />}
    </div>
  )
}

function AssetRow({ asset, holding }: { asset: MarketAsset; holding?: Holding }) {
  return (
    <li>
      <Link href={`/app/market/${asset.symbol}`} className="flex min-h-[72px] items-center gap-3 px-4 py-3 hover:bg-ink/[0.03] focus-visible:bg-ink/[0.03]">
        <MetalMark symbol={asset.symbol} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-[680]">{asset.name}</span>
          <span className="block truncate text-[13px] text-muted">{holding && holding.quantityMg > 0 ? `You hold ${gramsText(holding.quantityMg)}` : 'Per gram'}</span>
        </span>
        {/* Narrow phones: a shorter sparkline, none under 380 px, so the name and the holding are never cut (the change badge carries the trend). */}
        <Sparkline values={asset.history} className="hidden w-10 shrink-0 min-[380px]:block min-[420px]:w-16" />
        <span className="flex shrink-0 flex-col items-end">
          <span className="tabular text-[16px] font-[700]">
            {formatUsd(asset.priceMinor)}
            <span className="sr-only"> per gram</span>
          </span>
          <Change pct={asset.change24hPct} />
        </span>
        <ChevronRight className="hidden size-4 shrink-0 text-muted sm:block" aria-hidden="true" />
      </Link>
    </li>
  )
}

/** The metal's symbol in ink (readable in both themes), inside a ring in the metal's tone. */
export function MetalMark({ symbol, size = 40 }: { symbol: string; size?: number }) {
  const tone = symbol === 'XAU' ? 'var(--brass)' : symbol === 'XAG' ? '#8C9096' : '#6E7B86'
  return (
    <span className="inline-grid shrink-0 place-items-center rounded-full border-[1.5px] bg-surface text-[11px] font-[760] tracking-[0.04em] text-ink" style={{ width: size, height: size, borderColor: tone }} aria-hidden="true">
      {symbol === 'XAU' ? 'Au' : symbol === 'XAG' ? 'Ag' : 'Pd'}
    </span>
  )
}

function HoldingsSummary({ holdings }: { holdings: Holding[] }) {
  const held = holdings.filter((h) => h.quantityMg > 0)
  if (!held.length) return null
  const total = held.reduce((s, h) => s + h.valueMinor, 0)
  return (
    <Panel title="Your metals" subtitle="Valued at what you would get selling now">
      <p className="tabular text-[28px] font-[740] tracking-[-0.03em]">{formatUsd(total)}</p>
    </Panel>
  )
}

function RowSkeleton() {
  return (
    <li className="flex min-h-[72px] items-center gap-3 px-4 py-3">
      <Skeleton className="size-10 rounded-full" />
      <span className="flex-1">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-3 w-16" />
      </span>
      <Skeleton className="h-5 w-24" />
    </li>
  )
}

export function NotAvailable() {
  return (
    <Panel className="mx-auto max-w-[520px] text-center">
      <p className="text-[16px] font-[650]">Metals are not available yet.</p>
      <Link href="/app" className="mt-3 inline-flex min-h-11 items-center text-[15px] font-[650] underline underline-offset-4">
        Go to home
      </Link>
    </Panel>
  )
}
