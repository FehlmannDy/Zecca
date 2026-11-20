import { describe, expect, it } from 'vitest'
import { approveStatus, archesFill } from './arches'

describe('arches progress', () => {
  it('starts empty, fills left to right, and never completes before the result', () => {
    expect(archesFill(0, 10_000)).toBe(0)
    const samples = [500, 2000, 5000, 9000, 10_000, 20_000, 120_000].map((t) => archesFill(t, 10_000))
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThan(samples[i - 1])
    expect(archesFill(10_000, 10_000)).toBeCloseTo(6.51, 1)
    expect(archesFill(600_000, 10_000)).toBeLessThan(7)
  })
  it('changes the status line from sealing to sending to confirmed', () => {
    expect(approveStatus(0.5, false)).toBe('Sealing the amount')
    expect(approveStatus(4, false)).toBe('Sending')
    expect(approveStatus(6.9, true)).toBe('Confirmed')
  })
})
