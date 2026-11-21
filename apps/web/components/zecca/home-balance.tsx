'use client'
// The phone home's balance: the number counts to each new value, and a small sparkline of the same series as the
// wide Peak Chart draws in under it on the first Home of a session (not on every tab switch). Both are static under
// prefers-reduced-motion (UI.md §6).
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useReducedMotion } from '@/lib/use-media'
import { Amount } from './amount'
import { useCountUp } from './count-up'
import { sparkGeometry, sparkLabel } from './home-spark'

/** The last balance this account saw, so coming back to Home counts from it instead of from zero. */
let lastSeen: { account: string; minor: number } | null = null

export function BalanceAmount({ minor, account }: { minor: number; account?: string }) {
  const reduced = useReducedMotion()
  const [from] = useState(() => (account && lastSeen?.account === account ? lastSeen.minor : 0))
  const shown = useCountUp(minor, { reduced, from })
  useEffect(() => {
    if (account) lastSeen = { account, minor }
  }, [account, minor])
  return <Amount minor={minor} shownMinor={shown} size="hero" />
}

const DRAW_MS = 700
const DOT_MS = 220

/** The account whose sparkline already drew in this session, so coming back to Home does not replay the wipe. */
let drawnFor: string | null = null

export function BalanceSpark({ values, mode, arrivingMinor = 0, account }: { values: number[]; mode: 'daily' | 'running'; arrivingMinor?: number; account?: string }) {
  const reduced = useReducedMotion()
  const g = useMemo(() => sparkGeometry(values), [values])
  const svg = useRef<SVGSVGElement>(null)
  const dot = useRef<HTMLSpanElement>(null)
  const shown = !!g
  // Before paint, so the finished line never shows for a frame before the wipe starts.
  useLayoutEffect(() => {
    const key = account ?? ''
    if (!shown || drawnFor === key) return
    drawnFor = key
    if (reduced) return
    // A left-to-right wipe over the line and its fill (a little past the box so the stroke is not cut), then the end
    // dot scales in, so the wipe never cuts it in half. Both styles revert to none when they end.
    svg.current?.animate?.([{ clipPath: 'inset(-4px 100% -4px -4px)' }, { clipPath: 'inset(-4px -4px -4px -4px)' }], { duration: DRAW_MS, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' })
    dot.current?.animate?.([{ opacity: 0, scale: '0.4' }, { opacity: 1, scale: '1' }], { duration: DOT_MS, delay: DRAW_MS - 60, easing: 'ease-out', fill: 'backwards' })
  }, [shown, reduced, account])
  if (!g) return null
  return (
    <div role="img" aria-label={sparkLabel(values, mode, arrivingMinor)} className="relative mt-4 h-16">
      <svg ref={svg} viewBox="0 0 100 64" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
        <defs>
          <linearGradient id="zecca-spark-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--brass)" stopOpacity="0.24" />
            <stop offset="1" stopColor="var(--brass)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={g.area} fill="url(#zecca-spark-fill)" />
        <path d={g.line} fill="none" stroke="var(--ink)" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      </svg>
      <span
        ref={dot}
        aria-hidden="true"
        className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-[3px] ring-brass/30"
        style={{ left: `${g.end.xPct}%`, top: `${g.end.yPct}%` }}
      />
    </div>
  )
}
