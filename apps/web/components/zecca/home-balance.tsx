'use client'
// The phone home's balance: the number counts to each new value, and a small sparkline of the same series as the
// wide Peak Chart draws in once under it. Both are static under prefers-reduced-motion (UI.md §6).
import { useEffect, useMemo, useRef, useState } from 'react'
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

export function BalanceSpark({ values, mode }: { values: number[]; mode: 'daily' | 'running' }) {
  const reduced = useReducedMotion()
  const g = useMemo(() => sparkGeometry(values), [values])
  const box = useRef<HTMLDivElement>(null)
  const drawn = useRef(false)
  const shown = !!g
  useEffect(() => {
    if (!shown || drawn.current) return
    drawn.current = true
    if (reduced) return
    // A left-to-right wipe over the line, its fill and the end dot; the style reverts to none when it ends.
    box.current?.animate?.([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }], { duration: DRAW_MS, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' })
  }, [shown, reduced])
  if (!g) return null
  return (
    <div ref={box} role="img" aria-label={sparkLabel(values, mode)} className="relative mt-4 h-16">
      <svg viewBox="0 0 100 64" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden="true">
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
        aria-hidden="true"
        className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink ring-[3px] ring-brass/30"
        style={{ left: `${g.end.xPct}%`, top: `${g.end.yPct}%` }}
      />
    </div>
  )
}
