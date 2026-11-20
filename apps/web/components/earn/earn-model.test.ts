import { describe, expect, it } from 'vitest'
import { chartSeries, feeLine, percentText, pollEvery, rateText, statusLine, xrpText } from './earn-model'

describe('Earn screen model', () => {
  it('formats XRP from integer drops, two decimals rounded down, or exact', () => {
    expect(xrpText(10_924_471)).toBe('10.92')
    expect(xrpText(10_924_471, { exact: true })).toBe('10.924471')
    expect(xrpText(0)).toBe('0.00')
    expect(xrpText(1_234_567_000_000)).toBe('1,234,567.00')
  })

  it('writes fees from basis points: the copy of UI.md §5.10 at the default fees', () => {
    expect(percentText(30)).toBe('0.3%')
    expect(percentText(1000)).toBe('10%')
    expect(percentText(25)).toBe('0.25%')
    expect(feeLine({ earnSwapBps: 30, earnFeeBps: 1000 })).toBe('0.3% conversion. Zecca keeps 10% of what you earn.')
  })

  it('shows the rate with four decimals and its time', () => {
    expect(rateText({ microUsdPerXrp: 912_630, at: '2026-11-20T22:28:51.000Z', source: 'CoinGecko', minorPerXrp: 91 }, 'UTC')).toBe('$0.9126 per XRP, CoinGecko, Nov 20, 10:28 PM')
  })

  it('charts real points only, in drops, with time labels', () => {
    const s = chartSeries([
      { at: '2026-11-20T22:00:00.000Z', valueDrops: 10_000_000 },
      { at: '2026-11-20T23:00:00.000Z', valueDrops: 10_002_000 },
    ], 'UTC')
    expect(s.data).toEqual([10_000_000, 10_002_000])
    expect(s.labels).toEqual(['Nov 20, 10:00 PM', 'Nov 20, 11:00 PM'])
    expect(chartSeries([], 'UTC').data).toEqual([])
  })

  it('says what is happening while money moves, and polls faster then', () => {
    expect(statusLine({ status: 'funding' } as never)).toBe('Converting your dollars to XRP')
    expect(statusLine({ status: 'opening' } as never)).toBe('Opening your Earn account on Flare. About 3 minutes.')
    expect(statusLine({ status: 'active' } as never)).toBeNull()
    expect(pollEvery({ status: 'opening' } as never)).toBe(5_000)
    expect(pollEvery({ status: 'active', pendingWithdrawal: { amountDrops: 1, claimableAt: '2026-11-21T04:00:00.000Z' } } as never)).toBe(60_000)
    expect(pollEvery({ status: 'none' } as never)).toBeNull()
  })
})
