import { expect, it } from 'vitest'
import { startLagMonitor } from './lag'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

it('logs an event-loop stall over the threshold, and nothing once stopped', async () => {
  const lines: string[] = []
  const stop = startLagMonitor({ log: (m) => lines.push(m), thresholdMs: 100, intervalMs: 150 })
  await sleep(50) // the histogram needs one sample as a baseline
  const until = Date.now() + 180
  while (Date.now() < until) {
    /* block the loop */
  }
  await sleep(250)
  expect(lines.some((l) => l.startsWith('[lag] event loop stalled'))).toBe(true)
  stop()
  const n = lines.length
  const until2 = Date.now() + 180
  while (Date.now() < until2) {
    /* block again, monitor is off */
  }
  await sleep(250)
  expect(lines.length).toBe(n)
})

it('stays quiet when the loop is free', async () => {
  const lines: string[] = []
  const stop = startLagMonitor({ log: (m) => lines.push(m), thresholdMs: 100, intervalMs: 100 })
  await sleep(250)
  stop()
  expect(lines).toEqual([])
})
