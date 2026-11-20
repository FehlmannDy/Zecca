// Limits (SPEC §4.8, UI.md §5.12) and the per-user prepare rate limit (SPEC §4.3).
import { formatUsd } from '@zecca/contracts'
import type { Core } from './core'
import { COPY, Err } from './errors'
import { getBalance } from './books'
import type { UserRow } from './users'

const SENDING_KINDS = "('p2p', 'merchant')"

const startOfUtcDay = (ms: number) => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}
const startOfUtcMonth = (ms: number) => {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/** What a user has sent since `fromMs`: intents that left the 'created' state for good (submitted, received, paid out) or are being submitted. */
export function sentSince(core: Core, userId: string, fromMs: number, excludeIntentId?: string): number {
  const r = core.db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor), 0) AS s FROM intents
       WHERE from_user_id = ? AND kind IN ${SENDING_KINDS} AND submitted_at IS NOT NULL AND submitted_at >= ?
         AND status NOT IN ('failed', 'expired') AND id != ?`,
    )
    .get(userId, core.iso(fromMs), excludeIntentId ?? '') as { s: number }
  return r.s
}

/** Refuses a payment above the sender's caps, or one that would take a tier-0 recipient over the balance cap. */
export function checkOutgoing(
  core: Core,
  sender: UserRow,
  recipient: UserRow | undefined,
  amountMinor: number,
  feeMinor: number,
  opts: { excludeIntentId?: string } = {},
): void {
  const s = core.settings
  const now = core.now()
  if (sender.tier === 0) {
    if (amountMinor > s.tier0.txCapMinor) throw Err.limit('per_payment', s.tier0.txCapMinor, amountMinor, COPY.tier0Limit)
    const month = sentSince(core, sender.id, startOfUtcMonth(now), opts.excludeIntentId)
    if (month + amountMinor > s.tier0.monthlySendCapMinor) throw Err.limit('monthly_send', s.tier0.monthlySendCapMinor, month, COPY.tier0Limit)
  } else if (amountMinor > s.txCapMinor) {
    throw Err.limit('tx_cap', s.txCapMinor, amountMinor, `Payments are limited to ${formatUsd(s.txCapMinor)} each.`)
  }
  const day = sentSince(core, sender.id, startOfUtcDay(now), opts.excludeIntentId)
  if (day + amountMinor > s.dailyCapMinor) throw Err.limit('daily_cap', s.dailyCapMinor, day, `You've reached today's limit of ${formatUsd(s.dailyCapMinor)}. Try again tomorrow.`)
  if (recipient) checkIncoming(core, recipient, amountMinor - feeMinor, 'payment', opts.excludeIntentId)
}

/**
 * Money on its way to a user that our books do not hold yet (net of fees): payments being submitted or submitted but not
 * received, and top-ups still being minted. Received money is already in pending.
 */
export function incomingInFlight(core: Core, userId: string, excludeIntentId?: string): number {
  const r = core.db
    .prepare(
      `SELECT COALESCE(SUM(amount_minor - fee_minor), 0) AS s FROM intents
       WHERE to_user_id = ? AND id != ? AND (status = 'submitted' OR (status = 'created' AND (submitted_at IS NOT NULL OR kind = 'topup')))`,
    )
    .get(userId, excludeIntentId ?? '') as { s: number }
  return r.s
}

/**
 * Tier-0 balance cap for money coming in, counting what is already on its way. `who`: 'payment' (the sender is told) or 'self'
 * (a top-up). Call it in the same transaction as the write that puts the new money on its way.
 */
export function checkIncoming(core: Core, user: UserRow, netMinor: number, who: 'payment' | 'self', excludeIntentId?: string): void {
  if (user.tier !== 0) return
  const cap = core.settings.tier0.balanceCapMinor
  const b = getBalance(core, user.id)
  const held = b.availableMinor + b.pendingMinor + incomingInFlight(core, user.id, excludeIntentId)
  if (held + netMinor <= cap) return
  if (who === 'self') throw Err.limit('balance', cap, held, COPY.tier0Limit)
  const name = user.roles.includes('merchant') && user.businessName ? user.businessName : user.displayName
  throw Err.limit(
    'balance',
    cap,
    held,
    `${name} can't receive that much yet. Unverified accounts can hold up to ${formatUsd(cap)}.`,
  )
}

/** Sliding one-minute window per key, in memory. */
export function createRateLimiter(core: Core, perMinute: number) {
  const hits = new Map<string, number[]>()
  return {
    hit(key: string): void {
      const now = core.now()
      const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000)
      if (recent.length >= perMinute) {
        hits.set(key, recent)
        throw Err.rateLimited()
      }
      recent.push(now)
      hits.set(key, recent)
    },
  }
}
