// Which links the home screen offers (UI.md §5.3), kept apart from React so it is tested on its own.
import type { PublicConfig } from '@zecca/contracts'

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
