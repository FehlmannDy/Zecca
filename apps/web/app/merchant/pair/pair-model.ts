// "Pair a till" (apps/merchant-till): the words on /merchant/pair. The calls are the till routes of the contracts' route table.
import type { ResponseOf } from '@zecca/contracts'

export type PairingCode = ResponseOf<'tillPairingCreate'>
export type TillView = ResponseOf<'tillList'>['items'][number]

/** The Android app, as committed in the public repository. */
export const TILL_APK_URL = 'https://github.com/FehlmannDy/Zecca/raw/main/apps/merchant-till/release/zecca-till.apk'

/** "ABCD2345" -> "ABCD 2345": easier to read across a counter. */
export const formatCode = (code: string): string => (code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code)

/** The till in `after` that was not in `before`: the one that just paired. */
export function newTillAfter(before: TillView[], after: TillView[]): TillView | undefined {
  const known = new Set(before.map((t) => t.id))
  return after.find((t) => !known.has(t.id))
}

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  return `on ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

/** "Paired 30 min ago · Used 5 min ago" */
export function tillSubtitle(t: TillView, now: number): string {
  return `Paired ${ago(t.pairedAt, now)}` + (t.lastSeenAt ? ` · Used ${ago(t.lastSeenAt, now)}` : '')
}
