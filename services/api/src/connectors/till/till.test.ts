// Zecca Till: pairing a merchant's Android till without Privy on the phone, and the till-scoped charge routes.
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { PaymentRequest, SalesResponse, matchRoute, routePath, routes, type RouteDef, type RouteName } from '@zecca/contracts'
import type { AppDeps } from '../../app'
import { featuresFrom, type Env } from '../../config'
import { createFakePool, type FakeLedger, type FakePool } from '../../testing/fakes'
import { eventually, makeHarness } from '../../testing/harness'
import { clientAddress } from './address'
import { CODE_ALPHABET, PAIRING_TTL_MS, TillList, TillPairResponse, TillPairingCode, normalizeCode } from './schemas'

const API_ORIGIN = 'https://zecca-api-production.up.railway.app'

/** Every FEATURE_* flag and DEMO_MODE on: no route can answer 404 (feature off, demo off) before its auth check. */
const EVERYTHING_ON: Env = {
  DEMO_MODE: '1',
  ...Object.fromEntries(Object.keys(featuresFrom({})).map((k) => [`FEATURE_${k.replace(/[A-Z]/g, (m) => `_${m}`).toUpperCase()}`, '1'])),
}

async function shop(o: { pool?: FakePool; env?: Env; extra?: Partial<AppDeps> } = {}) {
  const h = makeHarness<FakeLedger, FakePool>({ ...o, env: { API_ORIGIN, ...o.env } })
  const bruno = await h.signUp('caffebruno', { role: 'merchant', businessName: 'Caffè Bruno', displayName: 'Bruno Esposito' })
  const ana = await h.signUp('ana', { displayName: 'Ana Ferri' })
  const newCode = async () => {
    const r = await h.json('POST', '/v1/merchant/tills', { token: bruno.token })
    expect(r.status).toBe(200)
    return TillPairingCode.parse(r.body)
  }
  // `ip` is the address Railway's edge puts in X-Real-IP; `forwardedFor` is whatever the caller sends in X-Forwarded-For.
  const pair = async (code: string, ip = '203.0.113.7', name?: string, forwardedFor?: string) =>
    h.json('POST', '/v1/till/pair', {
      body: { code, ...(name ? { name } : {}) },
      headers: { 'x-real-ip': ip, ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}) },
    } as never)
  const pairedTill = async (name?: string) => {
    const c = await newCode()
    const r = await pair(c.pairingCode, '203.0.113.7', name)
    expect(r.status).toBe(200)
    return TillPairResponse.parse(r.body)
  }
  return { h, bruno, ana, newCode, pair, pairedTill }
}

describe('till pairing', () => {
  it('a merchant gets an 8-character single-use code, a zecca-till:// payload with the API origin, valid 10 minutes', async () => {
    const { h, newCode } = await shop()
    const c = await newCode()
    expect(c.pairingCode).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`))
    expect(c.qrPayload).toBe(`zecca-till://pair?api=${encodeURIComponent(API_ORIGIN)}&code=${c.pairingCode}`)
    expect(Date.parse(c.expiresAt) - h.clock.now).toBe(PAIRING_TTL_MS)
    expect(PAIRING_TTL_MS).toBe(600_000)
  })

  it('only a merchant session can ask for a code', async () => {
    const { h, ana } = await shop()
    expect((await h.json('POST', '/v1/merchant/tills', { token: ana.token })).status).toBe(403)
    expect((await h.json('POST', '/v1/merchant/tills')).status).toBe(401)
  })

  it('pairs once: the till gets a token and the merchant name; the same code is refused the second time', async () => {
    const { newCode, pair } = await shop()
    const c = await newCode()
    const first = await pair(c.pairingCode, '203.0.113.7', 'Pixel 8')
    expect(first.status).toBe(200)
    const p = TillPairResponse.parse(first.body)
    expect(p.merchantName).toBe('Caffè Bruno')
    expect(p.tillToken.length).toBeGreaterThanOrEqual(40)
    const again = await pair(c.pairingCode)
    expect(again.status).toBe(400)
    expect(again.body.error.message).toBe('This code is not valid or has expired. Show a new one in your Zecca merchant space.')
  })

  it('accepts the code typed in lower case, with spaces or a dash', async () => {
    const { newCode, pair } = await shop()
    const c = await newCode()
    const typed = `${c.pairingCode.slice(0, 4).toLowerCase()} - ${c.pairingCode.slice(4)}`
    expect(normalizeCode(typed)).toBe(c.pairingCode)
    expect((await pair(typed)).status).toBe(200)
  })

  it('a code expires after 10 minutes', async () => {
    const { h, newCode, pair } = await shop()
    const c = await newCode()
    h.clock.advance(PAIRING_TTL_MS + 1)
    const r = await pair(c.pairingCode)
    expect(r.status).toBe(400)
    expect(r.body.error.code).toBe('bad_request')
  })

  it('a new code replaces the merchant’s previous unused one', async () => {
    const { newCode, pair } = await shop()
    const old = await newCode()
    const fresh = await newCode()
    expect((await pair(old.pairingCode)).status).toBe(400)
    expect((await pair(fresh.pairingCode)).status).toBe(200)
  })

  it('the token is stored hashed, never in clear', async () => {
    const { h, pairedTill } = await shop()
    const t = await pairedTill()
    const dump = JSON.stringify(h.app.core.db.prepare('SELECT * FROM tills').all())
    expect(dump).not.toContain(t.tillToken)
  })

  it('pairing is rate limited per address: the one the edge sets, whatever X-Forwarded-For the caller sends', async () => {
    const { pair } = await shop()
    const answers: number[] = []
    for (let i = 0; i < 12; i++) answers.push((await pair('AAAAAAAA', '198.51.100.9', undefined, `192.0.2.${i}, 198.51.100.9`)).status)
    expect(answers.slice(0, 10).every((s) => s === 400)).toBe(true)
    expect(answers.slice(10)).toEqual([429, 429])
    // Another address is not blocked.
    expect((await pair('AAAAAAAA', '198.51.100.10')).status).toBe(400)
  })

  it('pairing is also capped for everyone together (300 a minute)', async () => {
    const { pair } = await shop()
    for (let i = 0; i < 300; i++) expect((await pair('AAAAAAAA', `10.0.${i >> 8}.${i & 255}`)).status).toBe(400)
    expect((await pair('AAAAAAAA', '198.51.100.77')).status).toBe(429)
  })

  it('the client address: X-Real-IP (set by Railway’s edge), else the socket; never the caller’s X-Forwarded-For', async () => {
    const app = new Hono().get('/', (c) => c.text(clientAddress(c)))
    const ask = async (headers: Record<string, string>, remoteAddress?: string) =>
      (await app.request('/', { headers }, remoteAddress ? { incoming: { socket: { remoteAddress } } } : undefined)).text()
    expect(await ask({ 'x-real-ip': ' 198.51.100.9 ', 'x-forwarded-for': '192.0.2.1' }, '100.64.0.2')).toBe('198.51.100.9')
    expect(await ask({ 'x-forwarded-for': '192.0.2.1, 192.0.2.2' }, '127.0.0.1')).toBe('127.0.0.1')
    expect(await ask({ 'x-forwarded-for': '192.0.2.1' })).toBe('local')
  })

  it('refuses a wrong body with 400 and an English message', async () => {
    const { h } = await shop()
    for (const body of [{}, { code: 12 }, '{not json']) {
      const r = await h.json('POST', '/v1/till/pair', { body })
      expect(r.status).toBe(400)
      expect(r.body.error.message).toMatch(/^[A-Za-z@].*[.!]$/)
    }
  })

  it('the merchant lists paired tills (name, paired time) and can unpair one; the token stops working', async () => {
    const { h, bruno, pairedTill } = await shop()
    const t = await pairedTill('Pixel 8')
    const list = TillList.parse((await h.json('GET', '/v1/merchant/tills', { token: bruno.token })).body)
    expect(list.items).toEqual([{ id: t.tillId, name: 'Pixel 8', pairedAt: new Date(h.clock.now).toISOString() }])

    expect((await h.json('POST', '/v1/till/charges', { token: t.tillToken, body: { amountMinor: 450 } })).status).toBe(200)
    const lastSeen = TillList.parse((await h.json('GET', '/v1/merchant/tills', { token: bruno.token })).body).items[0]
    expect(lastSeen.lastSeenAt).toBeDefined()

    const rv = await h.json('POST', `/v1/merchant/tills/${t.tillId}/revoke`, { token: bruno.token })
    expect(rv.status).toBe(200)
    expect(rv.body).toEqual({ ok: true })
    expect(TillList.parse((await h.json('GET', '/v1/merchant/tills', { token: bruno.token })).body).items).toEqual([])
    const after = await h.json('POST', '/v1/till/charges', { token: t.tillToken, body: { amountMinor: 450 } })
    expect(after.status).toBe(401)
    expect(after.body.error.message).toBe('This till is not paired. Pair it again from your Zecca merchant space.')
  })

  it('a merchant cannot unpair another merchant’s till', async () => {
    const { h, pairedTill } = await shop()
    const t = await pairedTill()
    const other = await h.signUp('gelato', { role: 'merchant', businessName: 'Gelato Uno' })
    expect((await h.json('POST', `/v1/merchant/tills/${t.tillId}/revoke`, { token: other.token })).status).toBe(404)
    expect((await h.json('POST', '/v1/till/charges', { token: t.tillToken, body: { amountMinor: 100 } })).status).toBe(200)
  })

  it('a till with no name is called "Till"', async () => {
    const { h, bruno, pairedTill } = await shop()
    await pairedTill()
    expect((await h.json('GET', '/v1/merchant/tills', { token: bruno.token })).body.items[0].name).toBe('Till')
  })
})

describe('till charges', () => {
  it('creates a payment request for the merchant, reads it without marking it opened, and cancels it', async () => {
    const { h, pairedTill } = await shop()
    const t = await pairedTill()
    const c = await h.json('POST', '/v1/till/charges', { token: t.tillToken, body: { amountMinor: 450, reference: ' Table 4 ' } })
    expect(c.status).toBe(200)
    const pr = PaymentRequest.parse(c.body)
    expect(pr).toMatchObject({ status: 'created', merchantName: 'Caffè Bruno', amountMinor: 450, reference: 'Table 4', url: `http://localhost:3100/pay/${pr.id}` })
    expect(Date.parse(pr.expiresAt) - h.clock.now).toBe(600_000)

    const g = await h.json('GET', `/v1/till/charges/${pr.id}`, { token: t.tillToken })
    expect(g.status).toBe(200)
    expect(g.body.status).toBe('created')

    // The customer opens the link: the till sees "opened".
    await h.json('GET', `/v1/payment-requests/${pr.id}`)
    expect((await h.json('GET', `/v1/till/charges/${pr.id}`, { token: t.tillToken })).body.status).toBe('opened')

    const x = await h.json('POST', `/v1/till/charges/${pr.id}/cancel`, { token: t.tillToken })
    expect(x.status).toBe(200)
    expect(x.body.status).toBe('cancelled')
  })

  it('refuses a wrong amount and anything above the per-payment cap', async () => {
    const { h, pairedTill } = await shop()
    const t = await pairedTill()
    for (const body of [{ amountMinor: 0 }, { amountMinor: 12.5 }, { amountMinor: 'ten' }, { amountMinor: 100, reference: 'x'.repeat(61) }]) {
      const r = await h.json('POST', '/v1/till/charges', { token: t.tillToken, body })
      expect(r.status, JSON.stringify(body)).toBe(400)
    }
    const cap = h.app.core.settings.txCapMinor
    const big = await h.json('POST', '/v1/till/charges', { token: t.tillToken, body: { amountMinor: cap + 1 } })
    expect(big.status).toBe(400)
    expect(big.body.error.message).toMatch(/^The most per charge is \$[\d,]+\.\d\d\.$/)
  })

  it('a till only sees its own charges', async () => {
    const { h, bruno, pairedTill } = await shop()
    const a = await pairedTill('A')
    const b = await pairedTill('B')
    const pr = (await h.json('POST', '/v1/till/charges', { token: a.tillToken, body: { amountMinor: 300 } })).body
    expect((await h.json('GET', `/v1/till/charges/${pr.id}`, { token: b.tillToken })).status).toBe(404)
    expect((await h.json('POST', `/v1/till/charges/${pr.id}/cancel`, { token: b.tillToken })).status).toBe(404)
    // A charge made in the web till is not the till's either.
    const web = (await h.json('POST', '/v1/payment-requests', { token: bruno.token, body: { amountMinor: 200 } })).body
    expect((await h.json('GET', `/v1/till/charges/${web.id}`, { token: a.tillToken })).status).toBe(404)
  })

  it('the paid charge reads "paid" on the till and appears in the merchant’s sales, with the fee', async () => {
    const pool = createFakePool({ auto: false })
    const { h, bruno, ana, pairedTill } = await shop({ pool })
    const t = await pairedTill()
    const pr = PaymentRequest.parse((await h.json('POST', '/v1/till/charges', { token: t.tillToken, body: { amountMinor: 450, reference: 'Table 4' } })).body)
    const p = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    expect(p.status).toBe(200)
    const s = await h.submit(ana, p.body.prepared)
    expect(s.body.status).toBe('validated')
    pool.emit({ type: 'received', intentId: p.body.intent.id, txHash: s.body.hash, from: ana.user.address, amountMinor: 450 })
    await eventually(async () => expect((await h.json('GET', `/v1/till/charges/${pr.id}`, { token: t.tillToken })).body.status).toBe('paid'))
    await h.settle()
    const sales = SalesResponse.parse((await h.json('GET', '/v1/merchant/sales', { token: bruno.token })).body)
    expect(sales.items[0]).toMatchObject({ paymentRequestId: pr.id, amountMinor: 450, feeMinor: 2, netMinor: 448, reference: 'Table 4', payer: { handle: 'ana' } })
    // A paid charge cannot be cancelled.
    const x = await h.json('POST', `/v1/till/charges/${pr.id}/cancel`, { token: t.tillToken })
    expect(x.status).toBe(409)
    expect(x.body.error.message).toBe('This request has already been paid.')
  })

  it('an expired charge reads "expired"', async () => {
    const { h, pairedTill } = await shop()
    const t = await pairedTill()
    const pr = (await h.json('POST', '/v1/till/charges', { token: t.tillToken, body: { amountMinor: 450 } })).body
    h.clock.advance(601_000)
    expect((await h.json('GET', `/v1/till/charges/${pr.id}`, { token: t.tillToken })).body.status).toBe('expired')
  })
})

describe('till token scope', () => {
  // Every feature and DEMO_MODE on and every connector mounted, so each route reaches its auth check.
  const everythingOn = async () => {
    const s = await shop({ env: EVERYTHING_ON, extra: { connectors: true } })
    expect(Object.entries(s.h.app.core.settings.features).filter(([, on]) => !on)).toEqual([])
    return { ...s, t: await s.pairedTill() }
  }

  it('a till token is refused (401) on every other route of the route table', async () => {
    const { h, t } = await everythingOn()
    const call = (method: string, path: string, token?: string) => h.call(method, path, { token, ...(method === 'POST' ? { body: {} } : {}) })
    let refused = 0
    for (const [name, def] of Object.entries(routes) as [RouteName, RouteDef][]) {
      if (def.auth === 'till') continue
      const path = routePath(name, Object.fromEntries([...def.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => [m[1], 'x'])))
      const res = await call(def.method, path, t.tillToken)
      if (def.auth === 'public' || def.auth === 'webhook' || def.auth === 'demo') {
        // Open to anyone: the till token changes nothing.
        expect(res.status, `${def.method} ${def.path}`).toBe((await call(def.method, path)).status)
      } else {
        expect(res.status, `${def.method} ${def.path}`).toBe(401)
        refused++
      }
    }
    expect(refused).toBe(Object.values(routes).filter((d) => d.auth === 'user' || d.auth === 'merchant' || d.auth === 'dev').length)
    // The merchant's till routes are in the table: the till cannot list, pair or unpair tills.
    expect((await h.call('POST', `/v1/merchant/tills/${t.tillId}/revoke`, { token: t.tillToken })).status).toBe(401)
  })

  it('a till token is refused (401) on the routes connectors mount outside the table too', async () => {
    const { h, t } = await everythingOn()
    const registered = (h.app as unknown as { routes: { method: string; path: string }[] }).routes
    const offTable = registered
      .filter((r) => (r.method === 'GET' || r.method === 'POST') && r.path.startsWith('/v1/') && !matchRoute(r.method, r.path.replace(/:([a-zA-Z]+)/g, 'x')))
      .map((r) => ({ method: r.method, path: r.path.replace(/:([a-zA-Z]+)/g, 'x') }))
    expect(offTable.length).toBeGreaterThan(0)
    for (const r of offTable) {
      const res = await h.call(r.method, r.path, { token: t.tillToken, ...(r.method === 'POST' ? { body: {} } : {}) })
      expect(res.status, `${r.method} ${r.path}`).toBe(401)
    }
  })

  it('the till routes are in the route table (till token only for the charges) and all mounted', () => {
    const h = makeHarness()
    const till = (Object.entries(routes) as [RouteName, RouteDef][]).filter(([n]) => n.startsWith('till'))
    expect(Object.fromEntries(till.map(([n, d]) => [n, `${d.auth} ${d.method} ${d.path}`]))).toEqual({
      tillPairingCreate: 'merchant POST /v1/merchant/tills',
      tillList: 'merchant GET /v1/merchant/tills',
      tillRevoke: 'merchant POST /v1/merchant/tills/:id/revoke',
      tillPair: 'public POST /v1/till/pair',
      tillChargeCreate: 'till POST /v1/till/charges',
      tillChargeGet: 'till GET /v1/till/charges/:id',
      tillChargeCancel: 'till POST /v1/till/charges/:id/cancel',
    })
    expect(till.every(([, d]) => !d.feature)).toBe(true)
    const registered = new Set((h.app as unknown as { routes: { method: string; path: string }[] }).routes.map((r) => `${r.method} ${r.path}`))
    expect(till.filter(([, d]) => !registered.has(`${d.method} ${d.path}`)).map(([n]) => n)).toEqual([])
  })

  it('the till routes refuse a user or merchant session, and no token', async () => {
    const { h, bruno, ana } = await shop()
    for (const token of [bruno.token, ana.token, undefined]) {
      expect((await h.call('POST', '/v1/till/charges', { token, body: { amountMinor: 100 } })).status).toBe(401)
      expect((await h.call('GET', '/v1/till/charges/pr_x', { token })).status).toBe(401)
      expect((await h.call('POST', '/v1/till/charges/pr_x/cancel', { token })).status).toBe(401)
    }
  })
})
