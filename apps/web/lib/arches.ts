export const ARCH_COUNT = 7

/**
 * How many arches (0..7, fractional) are filled `elapsed` ms into a wait expected to last `expected` ms.
 * Eases out to 6.5 arches at the expected time, then creeps toward 7 without reaching it: only the result completes it.
 */
export function archesFill(elapsed: number, expected: number): number {
  const t = Math.max(0, elapsed / Math.max(1, expected))
  if (t <= 1) return ARCH_COUNT * 0.93 * (1 - Math.pow(1 - t, 1.8))
  return ARCH_COUNT * (0.93 + 0.06 * (1 - Math.exp(-(t - 1) * 1.5)))
}

/** Status line under the arches while a payment confirms (UI.md §5.4). */
export function approveStatus(fill: number, done: boolean): string {
  if (done) return 'Confirmed'
  return fill < ARCH_COUNT * 0.35 ? 'Sealing the amount' : 'Sending'
}
