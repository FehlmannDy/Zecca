import { describe, expect, it, vi } from 'vitest'
import * as fixtures from '@zecca/contracts/fixtures'
import { ZeccaApiError } from '../../lib/api'
import { createEarnApi } from './earn-api'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// The shared client parses responses with the contract's zod schemas, which drop the connector's extra fields
// (mode, rate, inFlight, ledger, quote.rateAt...). Until the contract has them, Earn calls its three routes itself.
describe('earn api client', () => {
  it('keeps the fields beyond the contract and sends the session', async () => {
    const seen: { url: string; auth: string | null; method?: string; body?: string }[] = []
    const fetch = vi.fn(async (u: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push({ url: String(u), auth: new Headers(init.headers).get('authorization'), method: init.method, body: init.body as string | undefined })
      return json({ ...fixtures.earnPosition, mode: 'mock', rate: { minorPerXrp: 91, microUsdPerXrp: 912_630, at: '2026-11-20T22:28:51.000Z', source: 'CoinGecko' } })
    })
    const api = createEarnApi({ origin: 'http://api.test', getToken: () => 'tok_abc', fetch })
    const p = await api.position()
    expect(p.mode).toBe('mock')
    expect(p.rate?.source).toBe('CoinGecko')
    expect(p.valueDrops).toBe(fixtures.earnPosition.valueDrops)
    expect(seen[0]).toEqual({ url: 'http://api.test/v1/earn/position', auth: 'Bearer tok_abc', method: 'GET', body: undefined })

    await api.deposit(1000)
    expect(seen[1]).toMatchObject({ url: 'http://api.test/v1/earn/deposits', method: 'POST', body: '{"amountMinor":1000}' })
  })

  it('throws the API error with its message, and calls onUnauthorized on a 401', async () => {
    const onUnauthorized = vi.fn()
    const err = { error: { code: 'forbidden', message: 'Verify your identity to use Earn.' } }
    const api = createEarnApi({ origin: 'http://api.test', fetch: async () => json(err, 403), onUnauthorized })
    await expect(api.deposit(1000)).rejects.toMatchObject({ status: 403, code: 'forbidden', message: 'Verify your identity to use Earn.' })
    const unauth = createEarnApi({ origin: 'http://api.test', fetch: async () => json({ error: { code: 'unauthorized', message: 'Please sign in again.' } }, 401), onUnauthorized })
    await expect(unauth.position()).rejects.toBeInstanceOf(ZeccaApiError)
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('says the app cannot reach Zecca when the network fails', async () => {
    const api = createEarnApi({ origin: 'http://api.test', fetch: async () => { throw new TypeError('fetch failed') } })
    await expect(api.withdraw(6_000_000)).rejects.toMatchObject({ status: 0, message: "Can't reach Zecca right now. Check your connection and try again." })
  })
})
