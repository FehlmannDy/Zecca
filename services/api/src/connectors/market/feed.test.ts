import { describe, expect, it } from 'vitest'
import { FIXTURE, change24hPct, createFixtureFeed, createHttpFeed, parseGoldApi, parseYahooChart } from './feed'

const yahoo = (price: number, closes: (number | null)[], t = 1795211997) => ({
  chart: {
    result: [
      {
        meta: { currency: 'USD', regularMarketPrice: price, regularMarketTime: t },
        timestamp: closes.map((_, i) => t - (closes.length - 1 - i) * 86_400),
        indicators: { quote: [{ close: closes }] },
      },
    ],
  },
})

function fakeFetch(routes: Record<string, () => unknown>) {
  const calls: string[] = []
  const f = (async (url: string) => {
    calls.push(String(url))
    for (const [k, v] of Object.entries(routes)) {
      if (String(url).includes(k)) {
        const body = v()
        if (body instanceof Error) throw body
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }
    }
    return new Response('nope', { status: 503 })
  }) as unknown as typeof fetch
  return Object.assign(f, { calls })
}

describe('market price feed', () => {
  it('the fixture is dated and per gram, in integer cents', async () => {
    const f = createFixtureFeed()
    const gold = await f.price('XAU')
    expect(gold).toEqual({ priceMinor: 11378, at: FIXTURE.at, source: expect.stringMatching(/2026-11-20/) })
    const h = await f.history('XAU', 5)
    expect(h).toHaveLength(5)
    expect(h.at(-1)).toBe(11378)
    for (const s of ['XAU', 'XAG', 'XPD'] as const) for (const v of await f.history(s, 100)) expect(Number.isSafeInteger(v)).toBe(true)
  })

  it('reads the Yahoo chart: price, time and daily closes, per gram', () => {
    const r = parseYahooChart(yahoo(3539, [3853, null, 3741.89990234375, 3539]))
    expect(r.priceMinor).toBe(11378)
    expect(r.at).toBe('2026-11-20T21:59:57.000Z')
    expect(r.history).toEqual([12388, 12030, 11378]) // null closes skipped, last = the price
  })

  it('reads gold-api.com', () => {
    expect(parseGoldApi({ name: 'Silver', price: 41.080002, symbol: 'XAG', updatedAt: '2026-11-20T22:30:06Z' })).toEqual({ priceMinor: 132, at: '2026-11-20T22:30:06.000Z' })
    expect(() => parseGoldApi({ price: 'x' })).toThrow()
  })

  it('change over the last day from the history, one decimal', () => {
    expect(change24hPct([12000, 11400])).toBe(-5)
    expect(change24hPct([3303, 3320])).toBe(0.5)
    expect(change24hPct([11378])).toBeUndefined()
  })

  it('live feed: one request per metal per cache period, history from the same source', async () => {
    const f = fakeFetch({ 'GC%3DF': () => yahoo(3539, [3853, 3539]), 'SI%3DF': () => yahoo(41.08, [44.3, 41.08]), 'PA%3DF': () => yahoo(893, [916.7, 893]) })
    let now = Date.parse('2026-11-20T23:00:00Z')
    const feed = createHttpFeed({ fetch: f, now: () => now, ttlMs: 60_000 })
    expect(await feed.price('XAU')).toEqual({ priceMinor: 11378, at: '2026-11-20T21:59:57.000Z', source: 'COMEX via Yahoo Finance' })
    expect(await feed.history('XAU', 30)).toEqual([12388, 11378])
    await Promise.all([feed.price('XAU'), feed.price('XAU')])
    expect(f.calls.filter((u) => u.includes('GC%3DF'))).toHaveLength(1)
    now += 61_000
    await feed.price('XAU')
    expect(f.calls.filter((u) => u.includes('GC%3DF'))).toHaveLength(2)
  })

  it('live feed: spot from gold-api.com when the chart is down, then the last good value, then the dated fixture', async () => {
    let yahooUp = true
    let goldUp = true
    const f = fakeFetch({
      'GC%3DF': () => (yahooUp ? yahoo(3539, [3853, 3539]) : new Error('down')),
      'gold-api.com/price/XAU': () => (goldUp ? { price: 3600, updatedAt: '2026-11-21T08:00:00Z' } : new Error('down')),
    })
    let now = Date.parse('2026-11-20T23:00:00Z')
    const feed = createHttpFeed({ fetch: f, now: () => now, ttlMs: 1000 })
    expect((await feed.price('XAU')).priceMinor).toBe(11378)
    yahooUp = false
    now += 2000
    const spot = await feed.price('XAU')
    expect(spot).toEqual({ priceMinor: 11574, at: '2026-11-21T08:00:00.000Z', source: 'gold-api.com' })
    // the chart keeps the daily closes it had, and the spot price is the newest point (a new day here)
    expect(await feed.history('XAU', 30)).toEqual([12388, 11378, 11574])
    goldUp = false
    now += 2000
    expect((await feed.price('XAU')).priceMinor).toBe(11574) // last good value, still dated
    // nothing ever loaded: the fixture, which says it is one
    const cold = createHttpFeed({ fetch: fakeFetch({}), now: () => now })
    expect((await cold.price('XPD')).source).toMatch(/Fixture/)
  })
})
