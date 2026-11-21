// The Peak Chart's width on Earn and the asset page: the phone's column (16 px gutters), up to 380 px, so the card and
// its text grow on a 390 or 430 phone instead of staying at 320.
import { useSyncExternalStore } from 'react'

const MAX = 380
const MIN = 280
const GUTTERS = 32

export const fitChartWidth = (viewport: number) => Math.max(MIN, Math.min(MAX, Math.floor(viewport) - GUTTERS))

function subscribe(onChange: () => void) {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

/** Live chart width for this window; 320 during server rendering. */
export function useChartWidth(): number {
  return useSyncExternalStore(
    subscribe,
    () => fitChartWidth(document.documentElement.clientWidth || window.innerWidth),
    () => 320,
  )
}
