// The pay page's state (UI.md §5.5): what the customer sees for a request, signed in or not, while and after paying.
import { formatUsd, spokenUsd, type PaymentRequest } from '@zecca/contracts'
import { isApiError, type ApiErrorDetails } from '../../lib/api'

export type PayFailure =
  | { kind: 'short'; shortMinor: number; message: string }
  | { kind: 'limit'; details?: ApiErrorDetails; message: string }
  | { kind: 'expired' }
  | { kind: 'already_paid' }
  | { kind: 'message'; message: string }

export type PayState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'signin' }
  | { kind: 'ready' }
  | { kind: 'own' }
  | { kind: 'working' }
  | { kind: 'paid'; at?: string }
  | { kind: 'already_paid' }
  | { kind: 'expired' }
  | { kind: 'cancelled' }
  | Extract<PayFailure, { kind: 'short' | 'limit' | 'message' }>

export const payTitle = (r: Pick<PaymentRequest, 'amountMinor' | 'merchantName'>) => `Pay ${formatUsd(r.amountMinor)} to ${r.merchantName}`
export const paidAnnouncement = (r: Pick<PaymentRequest, 'amountMinor' | 'merchantName'>) => `Paid, ${spokenUsd(r.amountMinor)} to ${r.merchantName}`

export function payState(o: {
  request: PaymentRequest | null
  loadError?: string | null
  signedIn: boolean
  userId?: string
  /** An approval of ours is in flight (prepare, sign, submit, wait for the deposit). */
  paying?: boolean
  /** Our payment went through (the submit validated). */
  paidByMe?: boolean
  failure?: PayFailure | null
}): PayState {
  const r = o.request
  if (!r) return o.loadError ? { kind: 'error', message: o.loadError } : { kind: 'loading' }
  if (r.status === 'paid') return o.paidByMe ? { kind: 'paid', at: r.paidAt } : { kind: 'already_paid' }
  if (r.status === 'expired') return { kind: 'expired' }
  if (r.status === 'cancelled') return { kind: 'cancelled' }
  if (o.paying) return { kind: 'working' }
  if (o.failure) {
    if (o.failure.kind === 'expired' || o.failure.kind === 'already_paid') return { kind: o.failure.kind }
    return o.failure
  }
  if (!o.signedIn) return { kind: 'signin' }
  if (o.userId && o.userId === r.merchantId) return { kind: 'own' }
  return { kind: 'ready' }
}

export function payErrorView(e: unknown): PayFailure {
  if (isApiError(e)) {
    if (e.code === 'insufficient_funds') return { kind: 'short', shortMinor: e.details?.shortMinor ?? 0, message: e.message }
    if (e.code === 'limit_reached') return { kind: 'limit', details: e.details, message: e.message }
    if (e.code === 'expired') return { kind: 'expired' }
    if (e.code === 'already_paid') return { kind: 'already_paid' }
    return { kind: 'message', message: e.message }
  }
  return { kind: 'message', message: e instanceof Error && e.message ? e.message : "That didn't go through and nothing was taken. Try again." }
}

const ID = /^[A-Za-z0-9_-]{3,64}$/

/** A scanned or pasted payment link from any Zecca host, or a bare request id, as our own /pay/<id> path. */
export function payLinkTarget(text: string): string | null {
  const s = text.trim()
  if (!s) return null
  if (ID.test(s)) return `/pay/${s}`
  let path: string
  try {
    const u = new URL(s)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    path = u.pathname
  } catch {
    path = s.split(/[?#]/)[0]
  }
  const m = /^\/pay\/([^/]+)\/?$/.exec(path)
  return m && ID.test(m[1]) ? `/pay/${m[1]}` : null
}
