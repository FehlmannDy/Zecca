// The identity screen's logic (UI.md §5.10), kept apart from React so it is tested on its own.
import { formatUsd, type IdentitySessionStatus, type Limits, type PreparedTx, type User, type VerifiedIdentity } from '@zecca/contracts'
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

export const NOT_THROUGH = "That didn't go through and nothing was taken. Try again."
export const STILL_CONFIRMING = 'Your approval is still being confirmed. Try again in a few minutes to see it.'
/** How long one press waits for an unconfirmed approval (the API settles it from the ledger on its jobs tick). */
export const LIFT_WAIT_MS = 3 * 60_000

export type ApproveDeps = {
  /** GET /v1/identity/sessions/:id */
  session(): Promise<Status>
  /** Sign the approval with the user's key and POST /v1/tx/submit. */
  submit(p: PreparedTx): Promise<{ status: string; user?: User }>
  /** GET /v1/me */
  me(): Promise<User>
  sleep(ms: number): Promise<void>
  now(): number
}

/** The submit's "not confirmed yet" answer (502 ledger_error): it may still land, so the next step is to wait, not to sign again. */
const unconfirmed = (e: unknown) => (e as { status?: number })?.status === 502 && (e as { code?: string })?.code === 'ledger_error'

/**
 * One press of Approve (or Try again) on the credential. Returns the lifted user; throws one sentence otherwise.
 * The server marks an approval used before it submits it, so a retry asks the session first: a fresh approval to sign once the
 * first finally failed, or none while it is being confirmed (or already accepted), and then it waits for the tier.
 */
export async function approveIdentity(d: ApproveDeps, held: PreparedTx, retry: boolean): Promise<User> {
  let prepared = held
  if (retry || needsFreshApproval(held, d.now())) {
    const v = viewOf(await d.session())
    if (v.kind === 'verified') return waitForLift(d)
    if (v.kind !== 'approve') throw new Error(v.kind === 'failed' ? v.message : 'Start the identity check again.')
    prepared = v.prepared
  }
  let res: { status: string; user?: User }
  try {
    res = await d.submit(prepared)
  } catch (e) {
    if (unconfirmed(e)) return waitForLift(d)
    throw e
  }
  // "Already accepted" (tecDUPLICATE) answers 'failed' with the lifted user: the check stands.
  if (res.user?.tier === 1) return res.user
  if (res.status === 'validated') return waitForLift(d)
  throw new Error(NOT_THROUGH)
}

async function waitForLift(d: ApproveDeps): Promise<User> {
  const until = d.now() + LIFT_WAIT_MS
  for (;;) {
    const u = await d.me()
    if (u.tier === 1) return u
    if (d.now() >= until) throw new Error(STILL_CONFIRMING)
    await d.sleep(POLL_MS)
    const v = viewOf(await d.session())
    // A fresh approval means the one sent finally failed: Try again signs the new one.
    if (v.kind === 'approve') throw new Error(NOT_THROUGH)
    if (v.kind === 'failed') throw new Error(v.message)
  }
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
