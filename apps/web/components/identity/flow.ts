// The identity screen's logic (UI.md §5.10), kept apart from React so it is tested on its own.
import { formatUsd, type IdentitySessionStatus, type Limits, type PreparedTx, type VerifiedIdentity } from '@zecca/contracts'
import type { z } from 'zod'

type Status = z.input<typeof IdentitySessionStatus>

/** Wallet link schemes: the EU reference wallet registers eudi-openid4vp; Paradym and Procivis register openid4vp. */
export const WALLETS = [
  { id: 'eudi', label: 'EU wallet', scheme: 'eudi-openid4vp' },
  { id: 'other', label: 'Other wallets', scheme: 'openid4vp' },
] as const
export type WalletId = (typeof WALLETS)[number]['id']

/** The same request under the chosen wallet's scheme (the query does not change). */
export function walletLink(link: string, wallet: WalletId): string {
  const scheme = WALLETS.find((w) => w.id === wallet)!.scheme
  return link.replace(/^[a-z][a-z0-9+.-]*:/i, `${scheme}:`)
}

export type View =
  | { kind: 'waiting' }
  | { kind: 'approve'; identity: VerifiedIdentity; prepared: PreparedTx }
  | { kind: 'verified'; identity: VerifiedIdentity; message?: string }
  | { kind: 'failed'; message: string }

export function viewOf(s: Status): View {
  if (s.status === 'pending') return { kind: 'waiting' }
  if (s.status === 'verified' && s.identity) {
    if (s.prepared) return { kind: 'approve', identity: s.identity, prepared: s.prepared as PreparedTx }
    return { kind: 'verified', identity: s.identity, message: s.message }
  }
  return { kind: 'failed', message: s.message || "That didn't work. Start again." }
}

export const POLL_MS = 2_000

/** Milliseconds to the next poll, or null once the session has expired (the server says so on the last poll). */
export function nextPollMs(expiresAt: string, nowMs: number): number | null {
  return nowMs >= Date.parse(expiresAt) ? null : POLL_MS
}

/** An approval this close to its expiry is fetched again before signing (the server prepares a fresh one). */
export function needsFreshApproval(p: Pick<PreparedTx, 'expiresAt'>, nowMs: number): boolean {
  return Date.parse(p.expiresAt) - nowMs < 30_000
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** "1994-03-12" -> "12 March 1994". Anything else is shown as given. */
export function formatBirthDate(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return d
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}`
}

export function liftedLimitsLine(limits: Pick<Limits, 'txCapMinor'>): string {
  return `You can now send up to ${formatUsd(limits.txCapMinor)} per payment.`
}
