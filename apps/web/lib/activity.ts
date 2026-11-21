// Words for an activity row. Pending and failed are said in words, never by colour alone.
import type { Activity } from '@zecca/contracts'

const KIND_TITLE: Record<string, string> = {
  welcome: 'Demo credit',
  topup: 'Top up',
  card_load: 'Card',
  earn_deposit: 'Earn',
  market_buy: 'Metals',
  withdraw: 'Withdrawal',
}

export function activityTitle(a: Activity): string {
  if (a.counterparty) return a.counterparty.displayName
  if (a.receipt) return a.receipt.shopName
  return KIND_TITLE[a.kind] ?? (a.direction === 'in' ? 'Received' : 'Sent')
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export function activityWhen(iso: string, now = new Date()): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (sameDay(d, now)) return `Today, ${time}`
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return `Yesterday, ${time}`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

/** The second line in two parts: the note (cut first on a narrow row) and when, with pending or failed. */
export function activityLineParts(a: Activity, now = new Date()): { note?: string; when: string } {
  const note = a.kind === 'welcome' ? 'Welcome to Zecca' : a.note || undefined
  const parts = [activityWhen(a.at, now)]
  if (a.status === 'pending') parts.push(a.direction === 'in' ? 'Arriving' : 'Pending')
  if (a.status === 'failed') parts.push('Failed')
  return { ...(note ? { note } : {}), when: parts.join(' · ') }
}

export function activityLine(a: Activity, now = new Date()): string {
  const { note, when } = activityLineParts(a, now)
  return note ? `${note} · ${when}` : when
}
