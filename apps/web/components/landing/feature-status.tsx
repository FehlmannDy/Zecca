'use client'
// Whether a phase 2 feature is switched on right now, read from GET /v1/config. Shows nothing until the config is in
// (or when the API is unreachable), so the page never claims more than the running build does.
import { useConfig } from '@/lib/app'
import type { Feature } from './content'

export function FeatureStatus({ feature }: { feature: Feature }) {
  const { config } = useConfig()
  if (!config) return null
  const on = config.features[feature] === true
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-[650] ${on ? 'text-in' : 'text-muted'}`}
      style={{ background: on ? 'color-mix(in srgb, var(--in) 10%, transparent)' : 'color-mix(in srgb, var(--muted) 10%, transparent)' }}
    >
      {on ? 'In the app' : 'Coming next'}
    </span>
  )
}
