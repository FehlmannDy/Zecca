// Which links the home screen offers (UI.md §5.3), kept apart from React so it is tested on its own.
import { splitUsd, formatUsd, type PublicConfig } from '@zecca/contracts'
import type { StreamStatus } from '@/lib/events'

export type HomeLinks = {
  /** Top up: MoonPay when the ramp is on, the demo credit in demo mode. */
  topup: boolean
  /** Where the tier 0 line ("Verify to lift it.") leads, when the identity check is on. */
  verifyHref?: string
}

/** Before the config arrives Top up stays in place, so the action row does not jump. */
export function homeLinks(config: Pick<PublicConfig, 'features' | 'demoMode'> | null | undefined): HomeLinks {
  if (!config) return { topup: true }
  return { topup: config.features.ramp || config.demoMode, ...(config.features.identity ? { verifyHref: '/app/identity' } : {}) }
}

const wholeUsd = (minor: number) => (minor % 100 === 0 ? `$${splitUsd(minor).dollars}` : formatUsd(minor))

/** The tier 0 line under the balance. It only asks to verify when the identity check is on. */
export function tierText(config: Pick<PublicConfig, 'features' | 'limits'> | null | undefined): string {
  if (!config) return ''
  const cap = wholeUsd(config.limits.tier0.balanceCapMinor)
  return config.features.identity ? `Limit ${cap}. Verify to lift it.` : `Limit ${cap} for unverified accounts.`
}

/** The chart's freshness label: never "Updated just now" once the polling that replaced the stream fails. */
export function liveLabel(stream: StreamStatus, stale: boolean): string {
  if (stream === 'live') return 'Live'
  return stale ? "Couldn't refresh" : 'Updated just now'
}
