import { describe, expect, it } from 'vitest'
import { createXrpPriceFeed, FIXTURE_RATE } from './price'

const reply = (body: string, status = 200) => async () => new Response(body, { status })

describe('XRP/USD price feed', () => {
  it('reads CoinGecko, keeps the decimal exact, and dates the rate with the source time', async () => {
    const feed = createXrpPriceFeed({ live: true, fetch: reply('{"ripple":{"usd":0.91263,"last_updated_at":1795213731}}') })
    expect(await feed.rate()).toEqual({ microUsdPerXrp: 912_630, at: '2026-11-20T22:28:51.000Z', source: 'CoinGecko' })
  })

  it('caches the live rate for a minute', async () => {
    let calls = 0
    let now = 1_000_000
    const feed = createXrpPriceFeed({
      live: true,
      now: () => now,
      fetch: async () => (calls++, new Response('{"ripple":{"usd":2.5,"last_updated_at":1795213731}}')),
    })
    await feed.rate()
    await feed.rate()
    expect(calls).toBe(1)
    now += 61_000
    await feed.rate()
    expect(calls).toBe(2)
  })

  it('falls back to the last good rate, then to the dated fixture, when the API fails', async () => {
    let ok = true
    let now = 0
    const feed = createXrpPriceFeed({
      live: true,
      now: () => now,
      fetch: async () => (ok ? new Response('{"ripple":{"usd":1.25,"last_updated_at":1795213731}}') : new Response('rate limited', { status: 429 })),
    })
    expect((await feed.rate()).microUsdPerXrp).toBe(1_250_000)
    ok = false
    now += 120_000
    expect((await feed.rate()).microUsdPerXrp).toBe(1_250_000)
    const cold = createXrpPriceFeed({ live: true, fetch: reply('nope', 500) })
    expect(await cold.rate()).toEqual(FIXTURE_RATE)
  })

  it('never calls the network when not live (tests, EARN_MODE=mock)', async () => {
    const feed = createXrpPriceFeed({ live: false, fetch: async () => { throw new Error('no network') } })
    expect(await feed.rate()).toEqual(FIXTURE_RATE)
    expect(FIXTURE_RATE.source).toMatch(/^Saved rate/)
  })
})
