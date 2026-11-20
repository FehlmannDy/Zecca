// Balance over time, rebuilt from the activity list (real data only) for the Peak Chart on wide screens.
import type { Activity } from '@zecca/contracts'

export type BalancePoint = { minor: number; label: string; at: string }
export type BalanceSeries = { mode: 'daily' | 'running'; points: BalancePoint[] }

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayLabel = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
const timeLabel = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const signed = (a: Activity) => (a.direction === 'in' ? a.amountMinor : -a.amountMinor)

/**
 * `currentMinor` is the balance shown now (available + arriving). Walks back through the activity to get the
 * balance at the end of each day. With a single day of history, returns the running balance after each payment.
 */
export function balanceSeries(activity: Activity[], currentMinor: number, now = new Date(), maxDays = 30): BalanceSeries {
  const items = activity.filter((a) => a.status !== 'failed').sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (items.length === 0) return { mode: 'daily', points: [] }
  const oldest = new Date(items[items.length - 1].at)

  const days: Date[] = []
  const cursor = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const first = new Date(oldest.getFullYear(), oldest.getMonth(), oldest.getDate())
  while (cursor >= first && days.length < maxDays) {
    days.unshift(new Date(cursor))
    cursor.setDate(cursor.getDate() - 1)
  }

  if (days.length >= 2) {
    const points = days.map((d) => {
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
      const after = items.filter((a) => Date.parse(a.at) >= end).reduce((s, a) => s + signed(a), 0)
      return { minor: Math.max(0, currentMinor - after), label: dayLabel(d), at: dayKey(d) }
    })
    return { mode: 'daily', points }
  }

  // One day of history: the balance before the first payment, then after each one.
  const chrono = [...items].reverse()
  let running = Math.max(0, currentMinor - chrono.reduce((s, a) => s + signed(a), 0))
  const points: BalancePoint[] = [{ minor: running, label: 'Start', at: chrono[0].at }]
  for (const a of chrono) {
    running = Math.max(0, running + signed(a))
    points.push({ minor: running, label: timeLabel(new Date(a.at)), at: a.at })
  }
  return { mode: 'running', points }
}
