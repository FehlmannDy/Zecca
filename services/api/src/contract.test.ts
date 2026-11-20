// Contract tests: iterate the route table; every phase-1 route answers its response schema (or a valid ApiError), and every
// request body is validated at runtime (400 bad_request with an English message).
import { describe, expect, it } from 'vitest'
import { ApiError, routePath, routes, type RouteDef, type RouteName } from '@zecca/contracts'
import { makeHarness, type TestUser } from './testing/harness'

type World = { h: ReturnType<typeof makeHarness>; ana: TestUser; bruno: TestUser; carla: TestUser; prId: string; intentId: string }

async function world(): Promise<World> {
  const h = makeHarness()
  const ana = await h.signUp('ana', { email: 'ana@example.com' })
  const bruno = await h.signUp('caffebruno', { role: 'merchant', businessName: 'Caffè Bruno' })
  const carla = await h.signUp('carla')
  const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1200, note: 'Dinner' } })
  await h.submit(ana, t.body.prepared)
  const pr = await h.json('POST', '/v1/payment-requests', { token: bruno.token, body: { amountMinor: 450, reference: 'Table 4' } })
  const pay = await h.json('POST', `/v1/payment-requests/${pr.body.id}/pay`, { token: ana.token })
  await h.submit(ana, pay.body.prepared)
  await h.settle()
  return { h, ana, bruno, carla, prId: pr.body.id, intentId: t.body.intent.id }
}

/** One representative successful call per phase-1 route. */
const CALLS: Record<string, (w: World) => Promise<Response>> = {
  health: ({ h }) => h.call('GET', routePath('health')),
  config: ({ h }) => h.call('GET', routePath('config')),
  authNonce: ({ h, ana }) => h.call('POST', routePath('authNonce'), { body: { address: ana.signer.address, publicKey: ana.signer.publicKey } }),
  authSession: async ({ h }) => {
    const { signer } = await h.signIn()
    const n = await h.json('POST', '/v1/auth/nonce', { body: { address: signer.address, publicKey: signer.publicKey } })
    const { signMessage } = await import('@zecca/xrpl-core/signer')
    return h.call('POST', routePath('authSession'), {
      body: { address: signer.address, publicKey: signer.publicKey, nonce: n.body.nonce, signature: await signMessage(signer.rawSign, n.body.message) },
    })
  },
  handleAvailable: ({ h }) => h.call('GET', routePath('handleAvailable') + '?handle=newname'),
  onboardingPrepare: async ({ h }) => {
    const { token, signer } = await h.signIn()
    return h.call('POST', routePath('onboardingPrepare'), {
      token,
      body: { address: signer.address, publicKey: signer.publicKey, handle: 'dora', displayName: 'Dora', role: 'user' },
    })
  },
  txSubmit: async ({ h, ana, carla }) => {
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 100 } })
    return h.call('POST', routePath('txSubmit'), { token: ana.token, body: { prepareId: t.body.prepared.prepareId, txBlob: await h.sign(ana.signer, t.body.prepared) } })
  },
  me: ({ h, ana }) => h.call('GET', routePath('me'), { token: ana.token }),
  balance: ({ h, ana }) => h.call('GET', routePath('balance'), { token: ana.token }),
  resolve: ({ h, ana }) => h.call('GET', routePath('resolve') + '?q=%40carla', { token: ana.token }),
  contacts: ({ h, ana }) => h.call('GET', routePath('contacts'), { token: ana.token }),
  transferCreate: ({ h, ana, carla }) => h.call('POST', routePath('transferCreate'), { token: ana.token, body: { to: carla.user.id, amountMinor: 100 } }),
  transferGet: ({ h, ana, intentId }) => h.call('GET', routePath('transferGet', { id: intentId }), { token: ana.token }),
  activity: ({ h, ana }) => h.call('GET', routePath('activity') + '?limit=50', { token: ana.token }),
  paymentRequestCreate: ({ h, bruno }) => h.call('POST', routePath('paymentRequestCreate'), { token: bruno.token, body: { amountMinor: 300 } }),
  paymentRequestGet: ({ h, prId }) => h.call('GET', routePath('paymentRequestGet', { id: prId })),
  paymentRequestEvents: ({ h, prId }) => h.call('GET', routePath('paymentRequestEvents', { id: prId })),
  paymentRequestPay: async ({ h, bruno, carla }) => {
    const pr = await h.json('POST', '/v1/payment-requests', { token: bruno.token, body: { amountMinor: 200 } })
    return h.call('POST', routePath('paymentRequestPay', { id: pr.body.id }), { token: carla.token })
  },
  paymentRequestCancel: async ({ h, bruno }) => {
    const pr = await h.json('POST', '/v1/payment-requests', { token: bruno.token, body: { amountMinor: 200 } })
    return h.call('POST', routePath('paymentRequestCancel', { id: pr.body.id }), { token: bruno.token })
  },
  sales: ({ h, bruno }) => h.call('GET', routePath('sales'), { token: bruno.token }),
  salesCsv: ({ h, bruno }) => h.call('GET', routePath('salesCsv'), { token: bruno.token }),
  events: ({ h, ana }) => h.call('GET', routePath('events'), { token: ana.token }),
  // Agent H's ramp connector and agent G's demo shop: off until they land (404 feature_off, a valid ApiError).
  rampSession: ({ h, ana }) => h.call('POST', routePath('rampSession'), { token: ana.token, body: { direction: 'buy' } }),
  rampSign: ({ h, ana }) => h.call('POST', routePath('rampSign'), { token: ana.token, body: { url: 'https://buy-sandbox.moonpay.com/?a=1' } }),
  moonpayWebhook: ({ h }) => h.call('POST', routePath('moonpayWebhook'), { body: {} }),
  devCredit: ({ h, carla }) => h.call('POST', routePath('devCredit'), { token: carla.token, body: { amountMinor: 1000 } }),
  shopItems: ({ h }) => h.call('GET', routePath('shopItems')),
  shopOrderCreate: ({ h }) => h.call('POST', routePath('shopOrderCreate'), { body: { items: [{ sku: 'guji-250', qty: 1 }] } }),
  shopOrderGet: async ({ h }) => {
    const o = await h.json('POST', routePath('shopOrderCreate'), { body: { items: [{ sku: 'guji-250', qty: 1 }] } })
    return h.call('GET', routePath('shopOrderGet', { id: o.body.orderId }))
  },
}
const NOT_YET: ReadonlySet<string> = new Set(['rampSession', 'rampSign', 'moonpayWebhook'])

const phase1 = (Object.entries(routes) as [RouteName, RouteDef][]).filter(([, d]) => d.phase === 1)

describe('contract: route table', () => {
  it('has a call for every phase-1 route', () => {
    expect(phase1.map(([n]) => n).filter((n) => !CALLS[n])).toEqual([])
  })

  it('every phase-1 response matches its schema', async () => {
    const w = await world()
    for (const [name, def] of phase1) {
      const res = await CALLS[name](w)
      const label = `${def.method} ${def.path} (${name}) -> ${res.status}`
      if (NOT_YET.has(name)) {
        expect(res.status, label).toBe(404)
        expect(ApiError.parse(await res.json()).error.code, label).toBe('feature_off')
        continue
      }
      expect(res.status, label).toBe(200)
      if (def.response === 'sse') {
        expect(res.headers.get('content-type'), label).toMatch(/text\/event-stream/)
        await res.body?.cancel()
      } else if (def.response === 'csv') {
        expect(res.headers.get('content-type'), label).toMatch(/text\/csv/)
        expect((await res.text()).split('\r\n')[0], label).toMatch(/^Date/)
      } else if (typeof def.response !== 'string') {
        const parsed = def.response.safeParse(await res.json())
        expect(parsed.success ? 'ok' : JSON.stringify(parsed.error.issues.slice(0, 2)), label).toBe('ok')
      }
      await w.h.settle()
    }
  })

  it('every phase-1 route with a body refuses a wrong body with 400 bad_request and an English message', async () => {
    const w = await world()
    const tokens: Record<string, string | undefined> = { public: undefined, user: w.ana.token, merchant: w.bruno.token, dev: w.ana.token, demo: undefined }
    for (const [name, def] of phase1) {
      if (!def.body || NOT_YET.has(name)) continue
      const params = Object.fromEntries([...def.path.matchAll(/:([a-zA-Z]+)/g)].map((m) => [m[1], 'x']))
      for (const bad of [{ amountMinor: 'ten' }, '{not json']) {
        const res = await w.h.call(def.method, routePath(name, params), { token: tokens[def.auth], body: bad })
        const label = `${name} with ${JSON.stringify(bad)} -> ${res.status}`
        expect(res.status, label).toBe(400)
        const err = ApiError.parse(await res.json()).error
        expect(err.code, label).toBe('bad_request')
        expect(err.message, label).toMatch(/^[A-Za-z@].*[.!]$/)
      }
    }
  })

  it('every error answer is a valid ApiError (auth failures, unknown ids)', async () => {
    const w = await world()
    for (const res of [
      await w.h.call('GET', '/v1/me'),
      await w.h.call('GET', '/v1/merchant/sales', { token: w.ana.token }),
      await w.h.call('GET', '/v1/transfers/int_nope', { token: w.ana.token }),
      await w.h.call('GET', '/v1/payment-requests/pr_nope'),
      await w.h.call('GET', '/v1/card', { token: w.ana.token }),
    ]) {
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(ApiError.safeParse(await res.json()).success).toBe(true)
    }
  })
})
