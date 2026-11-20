// What stops a send, in the order the API checks it (limits first, then the balance), and the copy around it.
// A tier 0 limit opens the limit sheet (UI.md §5.12); a missing amount is "You need $x more." with "Top up".
import { formatUsd, type ApiError, type Limits, type PublicProfile, type Tier } from '@zecca/contracts'

type Details = NonNullable<ApiError['error']['details']>

export type SendProblem =
  | { kind: 'empty' }
  | { kind: 'limit'; details: Details }
  | { kind: 'short'; shortMinor: number; message: string }
  | { kind: 'message'; message: string }

const short = (shortMinor: number): SendProblem => ({ kind: 'short', shortMinor, message: `You need ${formatUsd(shortMinor)} more.` })

/** Client-side check before asking the API. The monthly and daily caps need history, so only the API checks them. */
export function checkSendAmount(o: { minor: number | null; availableMinor: number | null; tier: Tier; limits: Limits }): SendProblem | null {
  const { minor, limits } = o
  if (minor === null || minor <= 0) return { kind: 'empty' }
  if (o.tier === 0 && minor > limits.tier0.txCapMinor) return { kind: 'limit', details: { limit: 'per_payment', capMinor: limits.tier0.txCapMinor, usedMinor: minor } }
  if (o.tier === 1 && minor > limits.txCapMinor) return { kind: 'message', message: `Payments are limited to ${formatUsd(limits.txCapMinor)} each.` }
  if (o.availableMinor !== null && minor > o.availableMinor) return short(minor - o.availableMinor)
  return null
}

/** The sender's own tier 0 limits are the ones the limit sheet lists; anything else is said in the API's words. */
const SHEET_LIMITS = new Set(['per_payment', 'monthly_send'])

export function sendProblemOf(e: { code: string; message: string; details?: Details }): SendProblem {
  if (e.code === 'limit_reached' && e.details?.limit && SHEET_LIMITS.has(e.details.limit)) return { kind: 'limit', details: e.details }
  if (e.code === 'insufficient_funds' && typeof e.details?.shortMinor === 'number') return short(e.details.shortMinor)
  return { kind: 'message', message: e.message }
}

export const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? ''

/** People by first name ("Sent. $12.00 to Carla."), businesses by their full name. */
export const recipientShortName = (p: Pick<PublicProfile, 'displayName' | 'isMerchant'>) => (p.isMerchant ? p.displayName.trim() : firstName(p.displayName))

export const sentTitle = (minor: number, to: Pick<PublicProfile, 'displayName' | 'isMerchant'>) => `Sent. ${formatUsd(minor)} to ${recipientShortName(to)}.`
