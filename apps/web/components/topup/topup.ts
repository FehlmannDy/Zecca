// Top up (UI.md §5.7): the amount chips within the tier 0 room, and what the screen says after a purchase, from live events.
// The credit is the amount delivered on the ledger (D5), so the screen reports the amount from the events, not the chip.
import type { Activity, Intent, Limits, Tier, ZeccaEvent } from '@zecca/contracts'

/** $25, $50, $100. MoonPay's minimum is about €21.60, so the smallest chip clears it. */
export const TOPUP_CHIPS = [2500, 5000, 10000] as const

/** Room left under the tier 0 balance cap (available + arriving), and which chips fit. null room: no cap applies. */
export function chipsFor(o: { tier: Tier; availableMinor: number | null; pendingMinor: number | null; limits: Limits }) {
  const known = o.availableMinor !== null && o.pendingMinor !== null
  const roomMinor = o.tier === 0 && known ? Math.max(0, o.limits.tier0.balanceCapMinor - o.availableMinor! - o.pendingMinor!) : null
  return { roomMinor, chips: TOPUP_CHIPS.map((minor) => ({ minor, allowed: roomMinor === null || minor <= roomMinor })) }
}

/** The web SDK's environment for the URL the API signed. */
export const sdkEnvironment = (widgetUrl: string): 'sandbox' | 'production' => (new URL(widgetUrl).hostname.includes('-sandbox') ? 'sandbox' : 'production')

export type TopupPhase = 'choose' | 'waiting' | 'arriving' | 'done' | 'failed'
export type TopupState = {
  phase: TopupPhase
  /** The chip paid for (MoonPay) or credited (demo). */
  expectedMinor?: number
  /** The amount actually credited, once known. */
  amountMinor?: number
  intentId?: string
  message?: string
  demo?: boolean
}

export const initialTopup: TopupState = { phase: 'choose' }

export type TopupAction =
  | { type: 'purchased'; amountMinor: number }
  | { type: 'demoCredit'; intent: Intent }
  | { type: 'event'; event: ZeccaEvent }
  /** Activity rows the screen polled while the live stream is down (only rows that were not there at the purchase). */
  | { type: 'activity'; items: Activity[] }
  | { type: 'reset' }

const FAILED = "We couldn't add this top-up. Our team has been told."
/** Credits come from Zecca itself (top-up, welcome credit): fromUserId 'zecca'. */
const isCredit = (i: Intent) => i.fromUserId === 'zecca'

export function topupReducer(s: TopupState, a: TopupAction): TopupState {
  if (a.type === 'reset') return initialTopup
  // MoonPay calls back on created and again on completed: only the first one starts the wait.
  if (a.type === 'purchased') return s.phase === 'choose' ? { phase: 'waiting', expectedMinor: a.amountMinor } : s
  if (a.type === 'demoCredit') {
    const failed = a.intent.status === 'failed' || a.intent.status === 'expired'
    return { phase: failed ? 'failed' : 'arriving', demo: true, intentId: a.intent.id, expectedMinor: a.intent.amountMinor, amountMinor: a.intent.amountMinor, ...(failed ? { message: a.intent.failure?.message ?? FAILED } : {}) }
  }
  if (s.phase !== 'waiting' && s.phase !== 'arriving') return s
  if (a.type === 'activity') {
    const mine = a.items.filter((x) => x.kind === 'topup' && x.direction === 'in' && (!s.intentId || x.intentId === s.intentId))
    const newest = mine.reduce<Activity | undefined>((n, x) => (!n || x.at > n.at ? x : n), undefined)
    return newest ? topupReducer(s, { type: 'event', event: { type: 'activity.created', data: newest, at: newest.at } }) : s
  }
  const e = a.event
  if (e.type === 'intent.updated') {
    const i = e.data
    if (!isCredit(i) || (s.intentId && i.id !== s.intentId)) return s
    if (i.status === 'failed' || i.status === 'expired') return { ...s, phase: 'failed', intentId: i.id, amountMinor: i.amountMinor, message: i.failure?.message ?? s.message ?? FAILED }
    return { ...s, phase: i.status === 'paid_out' ? 'done' : 'arriving', intentId: i.id, amountMinor: i.amountMinor }
  }
  if (e.type === 'activity.created') {
    const act = e.data
    if (act.kind !== 'topup' || act.direction !== 'in' || (s.intentId && act.intentId !== s.intentId)) return s
    if (act.status === 'failed') return { ...s, phase: 'failed', intentId: act.intentId, amountMinor: act.amountMinor, message: s.message ?? FAILED }
    return { ...s, phase: act.status === 'done' ? 'done' : 'arriving', intentId: act.intentId, amountMinor: act.amountMinor }
  }
  return s
}
