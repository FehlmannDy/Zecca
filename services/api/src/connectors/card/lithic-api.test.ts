// Lithic REST client (port of card-issuer/scripts/lithic-api.js), the simulate rate gate and result polling.
import { describe, expect, it } from 'vitest'
import { createGate, createLithicHttp, LithicError, waitForResult, type LithicApi } from './lithic-api'

type Seen = { url: string; method: string; headers: Record<string, string>; body?: string }

function fakeFetch(reply: (s: Seen) => { status: number; json?: unknown }) {
  const seen: Seen[] = []
  const f = (async (url: string, init: RequestInit = {}) => {
    const s: Seen = { url: String(url), method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: init.body as string | undefined }
    seen.push(s)
    const r = reply(s)
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { f, seen }
}

const KEY = 'test-key-0000'

describe('Lithic HTTP client', () => {
  it('sends the raw key in Authorization without Bearer, JSON bodies, to the sandbox', async () => {
    const { f, seen } = fakeFetch(() => ({ status: 201, json: { token: 'c1', last_four: '4417', exp_month: '11', exp_year: '2029', state: 'OPEN', pan: '4111111111114417', cvv: '123' } }))
    const api = createLithicHttp({ apiKey: KEY, fetch: f })
    const card = await api.createCard({ memo: 'Zecca @ana' })
    expect(seen[0]).toMatchObject({ url: 'https://sandbox.lithic.com/v1/cards', method: 'POST' })
    expect(seen[0].headers.Authorization).toBe(KEY)
    expect(JSON.parse(seen[0].body!)).toEqual({ type: 'VIRTUAL', memo: 'Zecca @ana', state: 'OPEN' })
    expect(card).toMatchObject({ token: 'c1', last4: '4417', expMonth: 11, expYear: 2029, state: 'OPEN', pan: '4111111111114417', cvv: '123' })
  })

  it('refuses a base URL that is not the sandbox', () => {
    expect(() => createLithicHttp({ apiKey: KEY, baseUrl: 'https://api.lithic.com' })).toThrow(/sandbox/)
  })

  it('needs an API key', () => {
    expect(() => createLithicHttp({ apiKey: '' })).toThrow(/LITHIC_API_KEY/)
  })

  it('freezes with PATCH state PAUSED and reads the card back', async () => {
    const { f, seen } = fakeFetch(() => ({ status: 200, json: { token: 'c1', last_four: '4417', exp_month: '01', exp_year: '2030', state: 'PAUSED' } }))
    const api = createLithicHttp({ apiKey: KEY, fetch: f })
    expect((await api.setCardState('c1', 'PAUSED')).state).toBe('PAUSED')
    expect(seen[0]).toMatchObject({ url: 'https://sandbox.lithic.com/v1/cards/c1', method: 'PATCH' })
    expect(JSON.parse(seen[0].body!)).toEqual({ state: 'PAUSED' })
  })

  it('simulates a purchase with amount, descriptor, pan and mcc', async () => {
    const { f, seen } = fakeFetch(() => ({ status: 201, json: { token: 'tx1', debugging_request_id: 'd' } }))
    const api = createLithicHttp({ apiKey: KEY, fetch: f })
    expect(await api.simulateAuthorize({ amount: 1450, descriptor: 'SETTE ARCHI', pan: '4111111111114417', mcc: '5812' })).toEqual({ token: 'tx1' })
    expect(JSON.parse(seen[0].body!)).toEqual({ amount: 1450, descriptor: 'SETTE ARCHI', pan: '4111111111114417', mcc: '5812' })
  })

  it('turns an error status into a LithicError that never carries the key', async () => {
    const { f } = fakeFetch(() => ({ status: 400, json: { message: `bad request for ${KEY}`, debugging_request_id: 'dbg1' } }))
    const api = createLithicHttp({ apiKey: KEY, fetch: f })
    const e = await api.getCard('c1').catch((x) => x)
    expect(e).toBeInstanceOf(LithicError)
    expect(e.status).toBe(400)
    expect(String(e.message)).not.toContain(KEY)
  })

  it('reads a transaction, and null when Lithic does not know it yet', async () => {
    let n = 0
    const { f } = fakeFetch(() => (++n === 1 ? { status: 404, json: { message: 'not found' } } : { status: 200, json: { token: 'tx1', status: 'PENDING', result: 'APPROVED' } }))
    const api = createLithicHttp({ apiKey: KEY, fetch: f })
    expect(await api.getTransaction('tx1')).toBeNull()
    expect(await api.getTransaction('tx1')).toMatchObject({ token: 'tx1', result: 'APPROVED' })
  })

  it('lists a card’s transactions', async () => {
    const { f, seen } = fakeFetch(() => ({ status: 200, json: { data: [{ token: 'tx1', status: 'SETTLED' }], has_more: false } }))
    const api = createLithicHttp({ apiKey: KEY, fetch: f })
    expect((await api.listTransactions({ cardToken: 'c1' })).map((t) => t.token)).toEqual(['tx1'])
    expect(seen[0].url).toMatch(/\/v1\/transactions\?card_token=c1&page_size=50$/)
  })

  it('reads the ASA secret and enrolls the responder URL', async () => {
    const { f, seen } = fakeFetch((s) => (s.url.endsWith('/v1/auth_stream/secret') ? { status: 200, json: { secret: 'whsec_abc' } } : { status: 200, json: {} }))
    const api = createLithicHttp({ apiKey: KEY, fetch: f })
    expect(await api.authStreamSecret()).toBe('whsec_abc')
    await api.enrollAsa('https://x.trycloudflare.com/v1/webhooks/lithic/asa')
    expect(JSON.parse(seen[1].body!)).toEqual({ type: 'AUTH_STREAM_ACCESS', url: 'https://x.trycloudflare.com/v1/webhooks/lithic/asa' })
  })
})

describe('simulate gate (sandbox: 1 call per second)', () => {
  it('runs one call at a time and spaces their starts', async () => {
    let t = 0
    const starts: number[] = []
    const gate = createGate(1100, { now: () => t, sleep: async (ms) => void (t += ms) })
    await Promise.all([1, 2, 3].map((i) => gate.run(async () => void starts.push(t + i * 0))))
    expect(starts).toEqual([0, 1100, 2200])
  })

  it('keeps going after a call fails', async () => {
    let t = 0
    const gate = createGate(1000, { now: () => t, sleep: async (ms) => void (t += ms) })
    await expect(gate.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok')
  })
})

describe('waitForResult (simulate returns 201 even on a decline)', () => {
  it('polls every 250 ms until the transaction carries a result', async () => {
    let reads = 0
    const slept: number[] = []
    const api = { getTransaction: async () => (++reads < 3 ? null : { token: 'tx1', status: 'PENDING', result: 'INSUFFICIENT_FUNDS' }) } as unknown as LithicApi
    const tx = await waitForResult(api, 'tx1', { sleep: async (ms) => void slept.push(ms) })
    expect(tx.result).toBe('INSUFFICIENT_FUNDS')
    expect(slept).toEqual([250, 250])
  })

  it('gives up after 5 s', async () => {
    let t = 0
    const api = { getTransaction: async () => ({ token: 'tx1', status: 'PENDING' }) } as unknown as LithicApi
    await expect(waitForResult(api, 'tx1', { now: () => t, sleep: async (ms) => void (t += ms) })).rejects.toThrow(/no result/)
  })

  it('reads again after a transient error (5xx, 429, network) instead of giving up at once', async () => {
    const errors = [new LithicError(503, 'Lithic GET /v1/transactions -> HTTP 503'), new LithicError(429, 'slow down'), new TypeError('fetch failed')]
    const api = {
      getTransaction: async () => {
        const e = errors.shift()
        if (e) throw e
        return { token: 'tx1', status: 'PENDING', result: 'APPROVED' }
      },
    } as unknown as LithicApi
    expect((await waitForResult(api, 'tx1', { sleep: async () => {} })).result).toBe('APPROVED')
  })

  it('throws at once on an error that will not go away (a 4xx other than 429), and the last error at the deadline', async () => {
    let reads = 0
    const bad = { getTransaction: async () => (reads++, Promise.reject(new LithicError(401, 'bad key'))) } as unknown as LithicApi
    await expect(waitForResult(bad, 'tx1', { sleep: async () => {} })).rejects.toThrow(/bad key/)
    expect(reads).toBe(1)
    let t = 0
    const down = { getTransaction: async () => Promise.reject(new LithicError(502, 'upstream down')) } as unknown as LithicApi
    await expect(waitForResult(down, 'tx1', { now: () => t, sleep: async (ms) => void (t += ms) })).rejects.toThrow(/upstream down/)
  })
})
