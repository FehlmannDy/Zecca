// The balance counts to its new value (UI.md §6 "numbers count", ease-out, none under reduced motion).
// Pure timing here so it is tested on its own; the hook only drives it with requestAnimationFrame.
import { useEffect, useRef, useState } from 'react'

/** First value on screen: up from zero. */
export const COUNT_FIRST_MS = 700
/** Any later change (money sent, money arriving): from the old value. */
export const COUNT_CHANGE_MS = 500

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)

/** The value shown `elapsedMs` into a count from `from` to `to`, in whole cents. */
export function countAt(from: number, to: number, elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to
  return Math.round(from + (to - from) * easeOutCubic(elapsedMs / durationMs))
}

/** The first-load duration only for the first count up from zero; a first count from a value seen before is a change. */
export function countDuration(from: number, to: number, first: boolean, reduced = false): number {
  if (reduced || from === to) return 0
  return first && from === 0 ? COUNT_FIRST_MS : COUNT_CHANGE_MS
}

/**
 * The number to draw while `target` changes. `from` is where the first count starts (0 by default). Re-renders
 * only the component that calls it, once per frame while counting; a change mid-count continues from where it is.
 */
export function useCountUp(target: number, { reduced, from = 0 }: { reduced: boolean; from?: number }): number {
  const [shown, setShown] = useState(reduced ? target : from)
  const current = useRef(shown)
  const first = useRef(true)
  useEffect(() => {
    const start = current.current
    const duration = countDuration(start, target, first.current, reduced)
    first.current = false
    const show = (v: number) => {
      current.current = v
      setShown(v)
    }
    if (duration === 0) {
      show(target)
      return
    }
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const v = countAt(start, target, now - t0, duration)
      show(v)
      if (v !== target) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, reduced])
  return shown
}
