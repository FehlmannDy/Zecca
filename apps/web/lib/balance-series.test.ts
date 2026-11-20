import { describe, expect, it } from 'vitest'
import type { Activity } from '@zecca/contracts'
import { balanceSeries } from './balance-series'

// Local times, so the day buckets hold in every time zone.
const L = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()
const act = (at: string, direction: 'in' | 'out', amountMinor: number, status: Activity['status'] = 'done'): Activity => ({
  id: at + direction + amountMinor,
  intentId: 'i',
  direction,
  kind: direction === 'in' ? 'topup' : 'p2p',
  amountMinor,
  feeMinor: 0,
  status,
  at,
  ledger: { network: 'devnet' },
})

describe('balance series from activity', () => {
  it('gives one end-of-day point per day, oldest first, ending at the current balance', () => {
    const items = [act(L(20, 12, 0), 'out', 1200), act(L(19, 12, 0), 'in', 4000), act(L(18, 12, 0), 'in', 5000)]
    const now = new Date(2026, 10, 20, 15, 0)
    const s = balanceSeries(items, 7800, now)
    expect(s.mode).toBe('daily')
    expect(s.points.map((p) => p.minor)).toEqual([5000, 9000, 7800])
    expect(s.points[0].label).toMatch(/Nov 18/)
  })

  it('fills quiet days with the carried balance', () => {
    const items = [act(L(20, 12, 0), 'out', 500), act(L(17, 12, 0), 'in', 5000)]
    const s = balanceSeries(items, 4500, new Date(2026, 10, 20, 15, 0))
    expect(s.points.map((p) => p.minor)).toEqual([5000, 5000, 5000, 4500])
  })

  it('on a first day, uses the running balance per payment, starting from zero', () => {
    const items = [act(L(20, 12, 5), 'out', 1200), act(L(20, 12, 0), 'in', 5000)]
    const s = balanceSeries(items, 3800, new Date(2026, 10, 20, 15, 0))
    expect(s.mode).toBe('running')
    expect(s.points.map((p) => p.minor)).toEqual([0, 5000, 3800])
  })

  it('ignores failed payments, and has fewer than two points with no activity', () => {
    const failed = [act(L(20, 12, 0), 'out', 999, 'failed')]
    expect(balanceSeries(failed, 0, new Date(2026, 10, 20, 15, 0)).points.length).toBeLessThan(2)
    expect(balanceSeries([], 0, new Date()).points.length).toBeLessThan(2)
  })

  it('never goes below zero (activity paged out of the list)', () => {
    const s = balanceSeries([act(L(20, 12, 0), 'in', 5000)], 1000, new Date(2026, 10, 20, 15, 0))
    expect(Math.min(...s.points.map((p) => p.minor))).toBeGreaterThanOrEqual(0)
  })
})
