// [lag] monitor (ported from card-issuer/src/server.js): logs any event-loop stall over the threshold.
import { monitorEventLoopDelay } from 'node:perf_hooks'

export function startLagMonitor({
  log,
  thresholdMs = 100,
  intervalMs = 5000,
}: {
  log: (m: string) => void
  thresholdMs?: number
  intervalMs?: number
}): () => void {
  const h = monitorEventLoopDelay({ resolution: 20 })
  h.enable()
  const t = setInterval(() => {
    const max = h.max / 1e6
    if (max > thresholdMs) log(`[lag] event loop stalled up to ${max.toFixed(0)} ms in the last ${(intervalMs / 1000).toFixed(1)} s`)
    h.reset()
  }, intervalMs)
  t.unref()
  return () => {
    clearInterval(t)
    h.disable()
  }
}
