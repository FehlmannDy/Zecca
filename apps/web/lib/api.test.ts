import { describe, expect, it, vi } from 'vitest'
import * as fixtures from '@zecca/contracts/fixtures'
import { createApi, ZeccaApiError } from './api'

function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => handler(new URL(String(input)), init))
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('api client', () => {
  it('calls the route from the table with the base origin and parses the response', async () => {
    const f = fakeFetch((url) => {
      expect(url.toString()).toBe('http://api.test/v1/config')
      return json(fixtures.config)
    })
    const api = createApi({ origin: 'http://api.test', fetch: f })
    const cfg = await api.call('config')
    expect(cfg.signerMode).toBe('mock')
    expect(cfg.features.ramp).toBe(true)
  })

  it('defaults the origin to http://localhost:8800', async () => {
    const f = fakeFetch((url) => (expect(url.origin).toBe('http://localhost:8800'), json(fixtures.config)))
    await createApi({ fetch: f }).call('config')
    expect(f).toHaveBeenCalledOnce()
  })

  it('sends the Bearer session, JSON body, path params and query', async () => {
    const seen: { url: string; auth: string | null; body: unknown; method?: string }[] = []
    const f = fakeFetch((url, init) => {
      seen.push({ url: url.pathname + url.search, auth: new Headers(init.headers).get('authorization'), body: init.body ? JSON.parse(String(init.body)) : undefined, method: init.method })
      if (url.pathname.startsWith('/v1/transfers/')) return json(fixtures.intents.p2pPaid)
      if (url.pathname === '/v1/activity') return json({ items: [fixtures.activity.welcome] })
      return json({ intent: fixtures.intents.p2pCreated, prepared: fixtures.preparedSend })
    })
    const api = createApi({ origin: 'http://api.test', fetch: f, getToken: () => 'tok_1234567890abcdef' })
    await api.call('transferCreate', { body: { to: 'usr_carla', amountMinor: 1200, note: 'Dinner' } })
    await api.call('transferGet', { params: { id: 'int p2p' } })
    await api.call('activity', { query: { limit: 20 } })
    expect(seen[0]).toEqual({ url: '/v1/transfers', auth: 'Bearer tok_1234567890abcdef', body: { to: 'usr_carla', amountMinor: 1200, note: 'Dinner' }, method: 'POST' })
    expect(seen[1].url).toBe('/v1/transfers/int%20p2p')
    expect(seen[1].method).toBe('GET')
    expect(seen[2].url).toBe('/v1/activity?limit=20')
  })

  it('throws a typed error whose message is the API message, as is, with the details', async () => {
    const f = fakeFetch(() => json(fixtures.errors.limit, 403))
    const api = createApi({ origin: 'http://api.test', fetch: f, getToken: () => 't' })
    const err = await api.call('transferCreate', { body: { to: 'usr_carla', amountMinor: 6000 } }).catch((e) => e)
    expect(err).toBeInstanceOf(ZeccaApiError)
    expect(err.message).toBe("You've reached the limit for unverified accounts. Verify your identity to lift it.")
    expect(err.code).toBe('limit_reached')
    expect(err.status).toBe(403)
    expect(err.details).toEqual({ limit: 'per_payment', capMinor: 5000, usedMinor: 6000 })
  })

  it('turns a network failure or a non-JSON error into a readable error', async () => {
    const down = createApi({ origin: 'http://api.test', fetch: vi.fn(async () => { throw new TypeError('Failed to fetch') }) })
    const e1 = await down.call('config').catch((e) => e)
    expect(e1).toBeInstanceOf(ZeccaApiError)
    expect(e1.code).toBe('upstream_error')
    expect(e1.message).toMatch(/connection/i)

    const html = createApi({ origin: 'http://api.test', fetch: fakeFetch(() => new Response('<html>502</html>', { status: 502 })) })
    const e2 = await html.call('config').catch((e) => e)
    expect(e2.status).toBe(502)
    expect(e2.message).toMatch(/try again/i)
  })

  it('reports 401 to onUnauthorized so the session can be cleared', async () => {
    const onUnauthorized = vi.fn()
    const api = createApi({ origin: 'http://api.test', fetch: fakeFetch(() => json({ error: { code: 'unauthorized', message: 'Sign in again.' } }, 401)), getToken: () => 't', onUnauthorized })
    await expect(api.call('me')).rejects.toThrow('Sign in again.')
    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('builds the events URL with the token in the query', () => {
    const api = createApi({ origin: 'http://api.test', getToken: () => 'tok/1' })
    expect(api.eventsUrl()).toBe('http://api.test/v1/events?token=tok%2F1')
  })
})
