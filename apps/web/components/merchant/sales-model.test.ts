import { describe, expect, it } from 'vitest'
import type { Sale } from '@zecca/contracts'
import { payerName, periodStart, salesInPeriod, salesSeries, totalsOf } from './sales-model'

// Local time is the machine's; build dates in local time so the buckets are stable anywhere.
const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()
const NOW = new Date(2026, 10, 21, 10, 30)
const sale = (paidAt: string, amountMinor = 450, extra: Partial<Sale> = {}): Sale => ({
  id: `sale_${paidAt}`,
  paymentRequestId: 'pr',
  amountMinor,
  feeMinor: Math.floor((amountMinor * 50 + 5000) / 10000),
  netMinor: amountMinor - Math.floor((amountMinor * 50 + 5000) / 10000),
  paidAt,
  payoutStatus: 'done',
  ...extra,
})

describe('sales view model', () => {
  it('period starts: today at midnight, 6 and 29 days before that', () => {
    expect(periodStart('Today', NOW).getTime()).toBe(new Date(2026, 10, 21).getTime())
    expect(periodStart('7 days', NOW).getTime()).toBe(new Date(2026, 10, 15).getTime())
    expect(periodStart('30 days', NOW).getTime()).toBe(new Date(2026, 9, 23).getTime())
  })

  it('filters sales by period and sums integer totals with an average', () => {
    const items = [sale(local(21, 9, 5)), sale(local(21, 8), 1000), sale(local(18, 12), 2000), sale(local(1, 12), 999)]
    expect(salesInPeriod(items, 'Today', NOW)).toHaveLength(2)
    expect(salesInPeriod(items, '7 days', NOW)).toHaveLength(3)
    expect(totalsOf(salesInPeriod(items, '7 days', NOW))).toEqual({ grossMinor: 3450, feeMinor: 2 + 5 + 10, netMinor: 3450 - 17, count: 3, averageMinor: 1150 })
    expect(totalsOf([])).toEqual({ grossMinor: 0, feeMinor: 0, netMinor: 0, count: 0, averageMinor: 0 })
  })

  it('today: one point per hour from midnight to now, sales summed in their hour', () => {
    const s = salesSeries([sale(local(21, 9, 5)), sale(local(21, 9, 55), 100), sale(local(21, 8))], 'Today', NOW)
    expect(s).toHaveLength(11)
    expect(s[0]).toEqual({ label: '12 AM', minor: 0 })
    expect(s[8]).toEqual({ label: '8 AM', minor: 450 })
    expect(s[9]).toEqual({ label: '9 AM', minor: 550 })
    expect(s[10]).toEqual({ label: '10 AM', minor: 0 })
  })

  it('7 and 30 days: one point per day, oldest first, ending today', () => {
    const s = salesSeries([sale(local(21, 9)), sale(local(20, 9), 100), sale(local(15, 0, 1), 7)], '7 days', NOW)
    expect(s.map((p) => p.minor)).toEqual([7, 0, 0, 0, 0, 100, 450])
    expect(s[6].label).toBe('Nov 21')
    expect(salesSeries([], '30 days', NOW)).toHaveLength(30)
  })

  it("payer: the first name, or 'Customer'", () => {
    expect(payerName(sale(local(21, 9), 450, { payer: { id: 'u', handle: 'ana', displayName: 'Ana Ferri', isMerchant: false } }))).toBe('Ana')
    expect(payerName(sale(local(21, 9)))).toBe('Customer')
  })
})
