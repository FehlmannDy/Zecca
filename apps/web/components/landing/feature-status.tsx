'use client'
// Whether a feature is switched on right now, read from GET /v1/config. Shows nothing until the config is in
// (or when the API is unreachable), so the page never claims more than the running build does.
// `when="off"` (the landing): only a feature that is switched off is marked; one that is on needs no badge.
import type { ReactNode } from 'react'
import { useConfig } from '@/lib/app'
import type { Feature } from './content'
import { heroTitle } from './hero-title'

export function FeatureStatus({ feature, when = 'always' }: { feature: Feature; when?: 'always' | 'off' }) {
  const { config } = useConfig()
  if (!config) return null
  const on = config.features[feature] === true
  if (on && when === 'off') return null
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-[12px] font-[650] ${on ? 'text-in' : 'text-muted'}`}
      style={{ background: on ? 'color-mix(in srgb, var(--in) 10%, transparent)' : 'color-mix(in srgb, var(--muted) 10%, transparent)' }}
    >
      {on ? 'In the app' : 'Coming next'}
    </span>
  )
}

/** Shows its children unless the feature is switched off. Until the config is in they show, as the page is built
 *  with every feature on (production has them all on), so only a build with a flag off loses a picture. */
export function FeatureGate({ feature, children }: { feature: Feature; children: ReactNode }) {
  const { config } = useConfig()
  return config?.features[feature] === false ? null : children
}

/** The hero's headline, naming only the features that are switched on. */
export function HeroTitle() {
  const { config } = useConfig()
  const f = config?.features
  return heroTitle({ card: f?.card !== false, earn: f?.earn !== false, market: f?.market !== false })
}
