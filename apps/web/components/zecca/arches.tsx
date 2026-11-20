'use client'
// The seven arches (UI.md §1): the progress indicator while a payment confirms, the empty-state illustration and
// a divider. Nowhere else.
import { useEffect, useRef, useState } from 'react'
import { useReducedMotion } from '@/lib/use-media'
import { cn } from '@/lib/cn'
import { archesFill, ARCH_COUNT as N } from '@/lib/arches'

const W = 22
const GAP = 10
const H = 40
const R = W / 2

const arch = (i: number) => {
  const x = i * (W + GAP) + 2
  return `M ${x} ${H} V ${R + 2} A ${R} ${R} 0 0 1 ${x + W} ${R + 2} V ${H}`
}
const VIEW = `0 0 ${N * W + (N - 1) * GAP + 4} ${H + 2}`

export type ArchesState = 'idle' | 'running' | 'done' | 'failed'

/**
 * Progress: fills left to right over `expectedMs` while `state` is 'running', completes on 'done'.
 * With reduced motion, whole arches appear one at a time, without easing.
 */
export function ArchesProgress({ state, expectedMs = 10_000, className, label }: { state: ArchesState; expectedMs?: number; className?: string; label?: string }) {
  const reduced = useReducedMotion()
  const [fill, setFill] = useState(0)
  const started = useRef<number | null>(null)
  const raf = useRef(0)

  useEffect(() => {
    cancelAnimationFrame(raf.current)
    if (state === 'idle') {
      started.current = null
      setFill(0)
      return
    }
    if (state === 'done') {
      setFill(N)
      return
    }
    if (state === 'failed') return
    if (started.current === null) started.current = performance.now()
    if (reduced) {
      const id = setInterval(() => setFill(Math.floor(archesFill(performance.now() - started.current!, expectedMs))), expectedMs / N / 2)
      setFill(Math.floor(archesFill(performance.now() - started.current, expectedMs)))
      return () => clearInterval(id)
    }
    const tick = () => {
      setFill(archesFill(performance.now() - started.current!, expectedMs))
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [state, expectedMs, reduced])

  const color = state === 'done' ? 'var(--in)' : state === 'failed' ? 'var(--muted)' : 'var(--ink)'
  return (
    <svg
      viewBox={VIEW}
      className={cn('h-10 w-auto overflow-visible', className)}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="progressbar"
      aria-label={label ?? 'Progress'}
      aria-valuemin={0}
      aria-valuemax={N}
      aria-valuenow={Math.floor(fill)}
    >
      {Array.from({ length: N }, (_, i) => {
        const f = Math.max(0, Math.min(1, fill - i))
        return (
          <g key={i}>
            <path d={arch(i)} stroke="var(--line)" strokeWidth={2.4} />
            <path
              d={arch(i)}
              stroke={color}
              strokeWidth={2.4}
              pathLength={1}
              strokeDasharray="1 1"
              strokeDashoffset={1 - f}
              style={{ transition: state === 'done' && !reduced ? `stroke-dashoffset 260ms ease-out ${i * 30}ms, stroke 200ms` : 'stroke 200ms' }}
            />
          </g>
        )
      })}
    </svg>
  )
}

/** Static arches: the empty-state illustration ('illustration') or a hairline divider ('divider'). */
export function Arches({ variant = 'illustration', className }: { variant?: 'illustration' | 'divider'; className?: string }) {
  if (variant === 'divider') {
    return (
      <div className={cn('flex items-center gap-3', className)} role="separator" aria-hidden="true">
        <span className="h-px flex-1 bg-line" />
        <svg viewBox={VIEW} className="h-4 w-auto" fill="none" stroke="var(--line)" strokeWidth={2.8} strokeLinecap="round">
          {Array.from({ length: N }, (_, i) => (
            <path key={i} d={arch(i)} />
          ))}
        </svg>
        <span className="h-px flex-1 bg-line" />
      </div>
    )
  }
  return (
    <svg viewBox={`0 -14 ${N * W + (N - 1) * GAP + 4} ${H + 16}`} className={cn('h-14 w-auto', className)} fill="none" strokeLinecap="round" aria-hidden="true">
      <path d={`M 2 -10 H ${N * W + (N - 1) * GAP + 2} M 2 -4 H ${N * W + (N - 1) * GAP + 2}`} stroke="var(--line)" strokeWidth={1.6} />
      {Array.from({ length: N }, (_, i) => (
        <path key={i} d={arch(i)} stroke={i === 0 ? 'var(--muted)' : 'var(--line)'} strokeWidth={2} />
      ))}
    </svg>
  )
}
