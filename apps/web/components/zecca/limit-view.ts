// What the limit sheet says (UI.md §5.12), kept apart from React so it is tested on its own. The tier 0 sheet is for an
// unverified account that hit one of its own caps; anything else (a verified payer, a recipient who can't receive that
// much, the verified caps) is one plain sentence, the API's own when the caller has it.
import { formatUsd, type Limits, type LimitName, type Tier } from '@zecca/contracts'
import type { ApiErrorDetails } from '@/lib/api'

export type LimitView = { kind: 'tier0'; hit?: LimitName } | { kind: 'other'; title: string; line: string }

const TIER0: ReadonlySet<LimitName> = new Set(['balance', 'per_payment', 'monthly_send'])

function lineFor(details: ApiErrorDetails | undefined, limits: Limits): string {
  const cap = details?.capMinor
  switch (details?.limit) {
    case 'balance':
      return `The recipient can't receive that much yet. Unverified accounts can hold up to ${formatUsd(cap ?? limits.tier0.balanceCapMinor)}.`
    case 'tx_cap':
      return `Payments are limited to ${formatUsd(cap ?? limits.txCapMinor)} each.`
    case 'daily_cap':
      return `You've reached today's limit of ${formatUsd(cap ?? limits.dailyCapMinor)}. Try again tomorrow.`
    default:
      return 'This payment is over a limit. Try a smaller amount.'
  }
}

export function limitView(o: { tier: Tier | undefined; limits: Limits; details?: ApiErrorDetails; message?: string }): LimitView {
  const hit = o.details?.limit
  if (o.tier !== 1 && (!hit || TIER0.has(hit))) return { kind: 'tier0', ...(hit ? { hit } : {}) }
  return { kind: 'other', title: 'This payment is over a limit.', line: o.message || lineFor(o.details, o.limits) }
}
