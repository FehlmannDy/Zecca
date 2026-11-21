// The till's state (UI.md §5.8), from the payment request as the API and its public stream report it.
import type { PaymentRequest } from '@zecca/contracts'

export type TillPhase = 'entry' | 'creating' | 'waiting' | 'paying' | 'paid' | 'expired' | 'cancelled'

export function tillPhase(r: PaymentRequest | null, creating: boolean): TillPhase {
  if (!r) return creating ? 'creating' : 'entry'
  switch (r.status) {
    case 'created':
      return 'waiting'
    case 'opened':
      return 'paying'
    default:
      return r.status
  }
}

const LINES: Partial<Record<TillPhase, string>> = {
  waiting: 'Waiting for the customer',
  paying: 'Customer is paying',
  paid: 'Paid',
  expired: 'This request has expired.',
  cancelled: 'Charge cancelled.',
}
export const tillStatusLine = (p: TillPhase): string => LINES[p] ?? ''

const RANK: Record<PaymentRequest['status'], number> = { created: 0, opened: 1, paid: 2, expired: 2, cancelled: 2 }

const same = (a: PaymentRequest, b: PaymentRequest) =>
  (Object.keys({ ...a, ...b }) as Array<keyof PaymentRequest>).every((k) => a[k] === b[k])

/** Events and polls can arrive out of order: keep the furthest state of the same request (the same object when nothing changed). */
export function mergeRequest(current: PaymentRequest | null, incoming: PaymentRequest): PaymentRequest {
  if (!current) return incoming
  if (incoming.id !== current.id || same(current, incoming)) return current
  return RANK[incoming.status] >= RANK[current.status] ? incoming : current
}

/**
 * Opens the Zecca NFC app (apps/merchant-nfc) with the request link. The custom-scheme deep link carries the link in its
 * data, so it survives every browser (Firefox for Android drops the S.url extra of an intent: link: NFC test 2).
 */
export function nfcAppUrl(requestUrl: string): string {
  return `zecca-nfc://emit?url=${encodeURIComponent(requestUrl)}`
}

/** The Chrome-only intent: form, kept for reference and tests. */
export function nfcIntentUrl(requestUrl: string): string {
  return `intent:#Intent;action=android.intent.action.VIEW;package=ch.ixh.nfcpaylink;S.url=${encodeURIComponent(requestUrl)};end`
}

export const isAndroid = (ua: string) => /Android/i.test(ua)

/** "9:41" left before the request expires; "0:00" once it has. */
export function expiresIn(expiresAt: string, now: number): string {
  const s = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
