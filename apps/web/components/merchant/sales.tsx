'use client'
// Merchant sales (UI.md §5.9): the glass metrics, the Peak Chart with Today / 7 days / 30 days, the live feed of sales
// and "Export CSV". One fetch of 30 days; periods are cut client-side. Live from the session's event stream.
import { useCallback, useMemo, useState } from 'react'
import { Banknote, Download, Hash, Percent, Receipt } from 'lucide-react'
import { formatUsd, type Sale, type ZeccaEvent } from '@zecca/contracts'
import { PeakChart } from '@/components/ui/peak-chart'
import { useApp } from '@/lib/app'
import { isApiError } from '@/lib/api'
import { useLiveEvents, useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/cn'
import { Amount } from '@/components/zecca/amount'
import { Button, EmptyState, Skeleton } from '@/components/zecca/bits'
import { Badge, Metric, Panel } from '@/components/zecca/glass'
import { PERIODS, payerName, periodStart, radioStep, salesInPeriod, salesSeries, totalsOf, type Period } from './sales-model'

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const dayOf = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const isToday = (iso: string) => new Date(iso).toDateString() === new Date().toDateString()

export function feeLine(feeBps: number): string {
  const pct = (feeBps / 100).toString()
  return `${pct}% per sale. No monthly fee.`
}

export function Sales({ wide }: { wide: boolean }) {
  const { api } = useApp()
  const session = useSession()
  const feeBps = session?.user?.merchant?.feeBps ?? 50
  const [period, setPeriod] = useState<Period>('Today')
  const [now, setNow] = useState(() => new Date())
  const from = useMemo(() => periodStart('30 days', now).toISOString(), [now])
  const sales = useResource(() => api.call('sales', { query: { from } }), [api, from])
  const [csvError, setCsvError] = useState('')

  const refresh = useCallback(() => {
    setNow(new Date())
    sales.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const onEvent = useCallback(
    (e: ZeccaEvent) => {
      if ((e.type === 'payment_request.updated' && e.data.status === 'paid') || e.type === 'intent.updated') refresh()
    },
    [refresh],
  )
  const stream = useLiveEvents(onEvent, refresh)

  const all = sales.data?.items ?? []
  const items = salesInPeriod(all, period, now)
  const t = totalsOf(items)
  const today = totalsOf(salesInPeriod(all, 'Today', now))
  const series = salesSeries(all, period, now)
  const busyBuckets = series.filter((p) => p.minor > 0).length

  async function exportCsv() {
    setCsvError('')
    try {
      const csv = await api.call('salesCsv', { query: { from: periodStart(period, now).toISOString() } })
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `zecca-sales-${period.replace(/\s+/g, '-').toLowerCase()}.csv`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setCsvError(isApiError(e) ? e.message : "We couldn't export your sales. Try again.")
    }
  }

  // A radio group: one Tab stop (the checked option), arrows move the choice.
  function onPeriodKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const next = radioStep(PERIODS.indexOf(period), PERIODS.length, e.key)
    if (next === null) return
    e.preventDefault()
    setPeriod(PERIODS[next])
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
  }

  const periodSwitch = (
    <div role="radiogroup" aria-label="Period" onKeyDown={onPeriodKey} className="inline-flex rounded-full border border-line bg-surface/70 p-1">
      {PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={p === period}
          tabIndex={p === period ? 0 : -1}
          onClick={() => setPeriod(p)}
          className={cn('min-h-10 rounded-full px-4 text-[13.5px] font-[650] transition-colors duration-150', p === period ? 'bg-ink text-paper' : 'text-muted hover:text-ink')}
        >
          {p}
        </button>
      ))}
    </div>
  )

  const metrics = (
    <div className="grid grid-cols-2 gap-3">
      {!sales.data ? (
        Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-[20px]" />)
      ) : (
        <>
          <Metric tone="in" title="Today" icon={<Banknote />} value={<Amount minor={today.grossMinor} size="lg" className="!text-current" />} caption={`${today.count} ${today.count === 1 ? 'sale' : 'sales'} today`} />
          <Metric title="Sales" icon={<Hash />} value={<span className="tabular">{t.count}</span>} caption={period === 'Today' ? 'Paid today' : `Last ${period}`} />
          <Metric title="Average" icon={<Receipt />} value={<Amount minor={t.averageMinor} size="lg" />} caption="Per sale" />
          <Metric title="Fees" icon={<Percent />} value={<Amount minor={t.feeMinor} size="lg" />} caption={feeLine(feeBps)} />
        </>
      )}
    </div>
  )

  const chartTitle = period === 'Today' ? 'Sales today' : `Sales, last ${period}`
  const chart = !sales.data ? (
    <Skeleton className="aspect-[540/696] w-full max-w-[380px] rounded-[40px]" />
  ) : busyBuckets >= 2 ? (
    <PeakChart
      width={wide ? 380 : 320}
      data={series.map((p) => p.minor)}
      labels={series.map((p) => p.label)}
      // Display only: the headline takes dollars; every sum stays in integer cents.
      value={t.grossMinor / 100}
      valuePrefix="$"
      valueSuffix=""
      decimals={2}
      title={chartTitle}
      caption={`${t.count} sales · Net ${formatUsd(t.netMinor)}`}
      updatedText={stream === 'live' ? 'Live' : 'Updated just now'}
      trend="none"
      periods={[...PERIODS]}
      period={period}
      onPeriodChange={(p) => setPeriod(p as Period)}
      accent="#A8842F"
      font='"Manrope Variable", Manrope, system-ui, sans-serif'
      formatValue={(v) => formatUsd(Math.max(0, Math.round(v)))}
    />
  ) : (
    <Panel className="w-full" title={chartTitle} subtitle={stream === 'live' ? 'Live' : undefined}>
      <Amount minor={t.grossMinor} size="hero" />
      <p className="mt-2 text-[14px] text-muted">
        {t.count === 0 ? 'No sales in this period yet.' : `${t.count} ${t.count === 1 ? 'sale' : 'sales'} · Net ${formatUsd(t.netMinor)}`}
      </p>
    </Panel>
  )

  const feed = (
    <Panel
      title="Sales"
      subtitle={feeLine(feeBps)}
      action={
        <Button variant="secondary" className="min-h-11 px-4 text-[13.5px]" onClick={exportCsv} disabled={!sales.data}>
          <Download className="size-4" aria-hidden="true" />
          Export CSV
        </Button>
      }
    >
      {csvError && (
        <p className="mb-3 text-[14px] text-alert" role="alert">
          {csvError}
        </p>
      )}
      {!sales.data ? (
        <div className="space-y-3" aria-busy="true" aria-label="Loading sales">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={period === 'Today' ? 'No sales yet today. Tap Charge to take your first payment.' : 'No sales in this period.'} />
      ) : (
        <ul className="divide-y divide-line" aria-live="polite" aria-relevant="additions">
          {items.slice(0, 60).map((s) => (
            <SaleRow key={s.id} s={s} />
          ))}
        </ul>
      )}
    </Panel>
  )

  // Nothing loaded: one error for the whole dashboard, not an error beside skeletons that never resolve.
  if (sales.error && !sales.data) {
    return (
      <Panel title="Sales" className="mx-auto w-full max-w-[560px]">
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-[15px] text-alert" role="alert">
            {sales.error}
          </p>
          <Button variant="secondary" onClick={sales.reload}>
            Try again
          </Button>
        </div>
      </Panel>
    )
  }

  if (!wide) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex justify-center">{periodSwitch}</div>
        {metrics}
        {/* The card's glow paints beyond its width: clip it at the screen edge so a phone never scrolls sideways. */}
        <div className="-mx-4 flex justify-center overflow-x-clip px-4">{chart}</div>
        {feed}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">{periodSwitch}</div>
      <div className="grid grid-cols-[380px_1fr] items-start gap-5">
        <div className="sticky top-4 flex flex-col items-center gap-4">{chart}</div>
        <div className="flex min-w-0 flex-col gap-4">
          {metrics}
          {feed}
        </div>
      </div>
    </div>
  )
}

function SaleRow({ s }: { s: Sale }) {
  return (
    <li className="flex min-h-16 items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-[15px] font-[650]">
          {payerName(s)}
          {s.reference && <span className="ml-2 font-[500] text-muted">{s.reference}</span>}
        </p>
        <p className="mt-0.5 text-[13px] text-muted">
          <span className="tabular">{isToday(s.paidAt) ? timeOf(s.paidAt) : `${dayOf(s.paidAt)}, ${timeOf(s.paidAt)}`}</span>
          {' · '}Fee <span className="tabular">{formatUsd(s.feeMinor)}</span> · Net <span className="tabular">{formatUsd(s.netMinor)}</span>
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="tabular text-[16px] font-[700]">{formatUsd(s.amountMinor)}</span>
        <Badge tone={s.payoutStatus === 'done' ? 'in' : 'brass'}>{s.payoutStatus === 'done' ? 'Paid out' : 'Paying out'}</Badge>
      </div>
    </li>
  )
}
