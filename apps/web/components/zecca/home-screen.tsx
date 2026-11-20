'use client'
// Home (UI.md §5.3): balance, "Available", "Arriving" when not zero, the tier 0 line, four actions, activity.
// Phone: plain large number. Wide: the Peak Chart of the daily balance (real points from the activity list).
import { useCallback, useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowDownLeft, ArrowUpRight, Clock3, Plus, RotateCw, ScanLine } from 'lucide-react'
import type { Activity, ZeccaEvent } from '@zecca/contracts'
import { formatUsd, splitUsd } from '@zecca/contracts'
import { PeakChart } from '@/components/ui/peak-chart'
import { useApp } from '@/lib/app'
import { balanceSeries } from '@/lib/balance-series'
import { useLiveEvents, useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { useWide } from '@/lib/use-media'
import { ActivityRow, ActivityRowSkeleton } from './activity-row'
import { Amount } from './amount'
import { Button, EmptyState, Skeleton } from './bits'
import { Metric, Panel } from './glass'

const wholeUsd = (minor: number) => (minor % 100 === 0 ? `$${splitUsd(minor).dollars}` : formatUsd(minor))

export function HomeScreen() {
  const { api, config } = useApp()
  const session = useSession()
  const wide = useWide()
  const balance = useResource(() => api.call('balance'), [api])
  const activity = useResource(() => api.call('activity', { query: { limit: 30 } }), [api])

  const onEvent = useCallback(
    (e: ZeccaEvent) => {
      if (e.type === 'balance.updated') balance.setData(e.data)
      if (e.type === 'activity.created')
        activity.setData((page) => {
          const items = page?.items ?? []
          const rest = items.filter((a) => a.id !== e.data.id && a.intentId !== e.data.intentId)
          return { ...(page ?? {}), items: [e.data, ...rest] }
        })
      if (e.type === 'intent.updated') activity.refresh()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const onPoll = useCallback(() => {
    balance.refresh()
    activity.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const stream = useLiveEvents(onEvent, onPoll)

  const items = activity.data?.items ?? []
  const b = balance.data
  const totalMinor = b ? b.availableMinor + b.pendingMinor : 0
  const series = useMemo(() => (b ? balanceSeries(items, totalMinor) : null), [items, b, totalMinor])
  const tier0 = session?.user?.tier === 0
  const features = config?.features

  const actions: { href: string; label: string; icon: ReactNode; show: boolean }[] = [
    { href: '/app/send', label: 'Send', icon: <ArrowUpRight className="size-5" aria-hidden="true" />, show: true },
    { href: '/app/pay', label: 'Pay', icon: <ScanLine className="size-5" aria-hidden="true" />, show: true },
    { href: '/app/topup', label: 'Top up', icon: <Plus className="size-5" aria-hidden="true" />, show: features?.ramp !== false },
    { href: '/app/request', label: 'Request', icon: <ArrowDownLeft className="size-5" aria-hidden="true" />, show: true },
  ]

  const balanceBlock = (
    <Panel className="relative overflow-hidden" aria-labelledby="balance-label">
      <span id="balance-label" className="label-caps text-muted">
        Balance
      </span>
      {balance.error && !b ? (
        <ErrorLine message={balance.error} onRetry={balance.reload} />
      ) : !b ? (
        <div className="mt-3 space-y-3" aria-busy="true">
          <Skeleton className="h-14 w-48" />
          <Skeleton className="h-4 w-28" />
        </div>
      ) : (
        <>
          <div className="mt-2" aria-live="polite">
            <Amount minor={b.availableMinor} size="hero" />
          </div>
          <p className="mt-2 text-[14px] text-muted">Available</p>
          {b.pendingMinor > 0 && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[14px] font-[600] text-ink">
              <Clock3 className="size-4 text-muted" aria-hidden="true" />
              Arriving: {formatUsd(b.pendingMinor)}
            </p>
          )}
          {tier0 && config && <p className="mt-4 border-t border-line pt-3 text-[13.5px] text-muted">Limit {wholeUsd(config.limits.tier0.balanceCapMinor)}. Verify to lift it.</p>}
        </>
      )}
    </Panel>
  )

  const chart =
    wide && b && series && series.points.length >= 2 ? (
      <div className="flex flex-col items-center gap-3">
        <PeakChart
          width={380}
          data={series.points.map((p) => p.minor)}
          labels={series.points.map((p) => p.label)}
          // Display only: the headline takes dollars; every sum above stays in integer cents.
          value={totalMinor / 100}
          valuePrefix="$"
          valueSuffix=""
          decimals={2}
          title="Balance"
          caption={b.pendingMinor > 0 ? `Arriving: ${formatUsd(b.pendingMinor)}` : 'Available'}
          updatedText={stream === 'live' ? 'Live' : 'Updated just now'}
          trend="none"
          periods={[series.mode === 'daily' ? 'By day' : 'Today']}
          period={series.mode === 'daily' ? 'By day' : 'Today'}
          accent="#A8842F"
          font='"Manrope Variable", Manrope, system-ui, sans-serif'
          formatValue={(v) => formatUsd(Math.max(0, Math.round(v)))}
        />
        {tier0 && config && <p className="text-[13.5px] text-muted">Limit {wholeUsd(config.limits.tier0.balanceCapMinor)}. Verify to lift it.</p>}
      </div>
    ) : null

  const actionRow = (
    <nav aria-label="Actions" className="grid grid-cols-4 gap-2">
      {actions
        .filter((a) => a.show)
        .map((a) => (
          <Link key={a.href} href={a.href} className="group flex min-h-[76px] flex-col items-center justify-center gap-2 rounded-[18px] px-1 py-2 text-[13px] font-[650] text-ink transition-colors duration-150 hover:bg-ink/[0.04]">
            <span className="grid size-12 place-items-center rounded-full bg-ink text-paper transition-transform duration-150 group-active:scale-95">{a.icon}</span>
            {a.label}
          </Link>
        ))}
    </nav>
  )

  const activityPanel = (
    <Panel title="Activity" aria-label="Activity" action={activity.error && activity.data ? <span className="text-[12px] text-alert">Couldn't refresh</span> : undefined}>
      {activity.error && !activity.data ? (
        <ErrorLine message={activity.error} onRetry={activity.reload} />
      ) : !activity.data ? (
        <div aria-busy="true" aria-label="Loading activity">
          {Array.from({ length: 4 }, (_, i) => (
            <ActivityRowSkeleton key={i} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing yet. Top up to get started."
          action={
            features?.ramp !== false ? (
              <Link href="/app/topup" className="inline-flex min-h-11 items-center rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[650]">
                Top up
              </Link>
            ) : undefined
          }
        />
      ) : (
        <ul className="-mx-2 flex flex-col">
          {items.map((a: Activity) => (
            <li key={a.id}>
              <ActivityRow activity={a} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )

  if (wide) {
    return (
      <div className="grid grid-cols-[400px_minmax(0,1fr)] items-start gap-6 pt-2">
        <div className="sticky top-6 flex flex-col gap-4">
          {chart ?? balanceBlock}
          {b && (
            <div className="gd-summary">
              <Metric title="Available" value={<Amount minor={b.availableMinor} size="lg" />} />
              <Metric title="Arriving" value={<Amount minor={b.pendingMinor} size="lg" tone={b.pendingMinor ? undefined : 'muted'} />} caption={b.pendingMinor ? 'On its way' : 'Nothing pending'} />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4">
          <Panel>{actionRow}</Panel>
          {activityPanel}
        </div>
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-4">
      {balanceBlock}
      <div className="px-1">{actionRow}</div>
      {activityPanel}
    </div>
  )
}

function ErrorLine({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 py-3" role="alert">
      <p className="text-[15px] text-ink">{message}</p>
      <Button variant="secondary" onClick={onRetry} className="min-h-11">
        <RotateCw className="size-4" aria-hidden="true" /> Retry
      </Button>
    </div>
  )
}
