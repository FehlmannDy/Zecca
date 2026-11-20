// The merchant's sales dashboard (UI.md §5.9): periods, totals and the Peak Chart series, from GET /v1/merchant/sales.
// Buckets are in the viewer's local time. Integer cents throughout.
import type { Sale } from '@zecca/contracts'

export const PERIODS = ['Today', '7 days', '30 days'] as const
export type Period = (typeof PERIODS)[number]

const DAYS: Record<Period, number> = { Today: 0, '7 days': 6, '30 days': 29 }

export function periodStart(p: Period, now: Date): Date {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - DAYS[p])
  return d
}

export function salesInPeriod(items: Sale[], p: Period, now: Date): Sale[] {
  const from = periodStart(p, now).getTime()
  return items.filter((s) => Date.parse(s.paidAt) >= from)
}

export function totalsOf(items: Sale[]) {
  const t = items.reduce((a, s) => ({ grossMinor: a.grossMinor + s.amountMinor, feeMinor: a.feeMinor + s.feeMinor, netMinor: a.netMinor + s.netMinor, count: a.count + 1 }), {
    grossMinor: 0,
    feeMinor: 0,
    netMinor: 0,
    count: 0,
  })
  return { ...t, averageMinor: t.count ? Math.round(t.grossMinor / t.count) : 0 }
}

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`
const dayLabel = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

/** Today: one point per hour from midnight to the current hour. 7 / 30 days: one point per day, ending today. */
export function salesSeries(items: Sale[], p: Period, now: Date): Array<{ label: string; minor: number }> {
  const start = periodStart(p, now)
  const inPeriod = salesInPeriod(items, p, now)
  if (p === 'Today') {
    const points = Array.from({ length: now.getHours() + 1 }, (_, h) => ({ label: hourLabel(h), minor: 0 }))
    for (const s of inPeriod) {
      const h = new Date(s.paidAt).getHours()
      if (points[h]) points[h].minor += s.amountMinor
    }
    return points
  }
  const days = Array.from({ length: DAYS[p] + 1 }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    return d
  })
  const points = days.map((d) => ({ label: dayLabel(d), minor: 0 }))
  for (const s of inPeriod) {
    const d = new Date(s.paidAt)
    const i = days.findIndex((x) => x.getFullYear() === d.getFullYear() && x.getMonth() === d.getMonth() && x.getDate() === d.getDate())
    if (i >= 0) points[i].minor += s.amountMinor
  }
  return points
}

export const payerName = (s: Sale) => s.payer?.displayName.trim().split(/\s+/)[0] || 'Customer'
