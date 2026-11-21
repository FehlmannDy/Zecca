// Every MSW handler's response validates against its route's response schema (contracts route table).
import { describe, expect, it } from 'vitest'
import { getResponse } from 'msw'
import { ApiError, routes, routePath, type RouteName } from '@zecca/contracts'
import * as fx from '@zecca/contracts/fixtures'
import { mockRawSigner, signMessage } from '@zecca/xrpl-core/signer'
import type { z } from 'zod'
import { createHandlers } from './handlers'
import { createMockState, ALL_FEATURES_ON } from './state'

const ORIGIN = 'http://api.mock'

function harness(opts: Parameters<typeof createMockState>[0] = {}) {
  const state = createMockState({ delays: { submitMs: 0, receiveMs: 0, payoutMs: 0, networkMs: 0 }, ...opts })
  const handlers = createHandlers(state, ORIGIN)
  const hit = new Set<RouteName>()
  async function call(name: RouteName, o: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown; token?: string } = {}) {
    const def = routes[name]
    const u = new URL(ORIGIN + routePath(name, o.params))
    for (const [k, v] of Object.entries(o.query ?? {})) u.searchParams.set(k, v)
    const headers: Record<string, string> = {}
    if (o.token) headers.authorization = `Bearer ${o.token}`
    if (o.body !== undefined) headers['content-type'] = 'application/json'
    const req = new Request(u, { method: def.method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) })
    const res = await getResponse(handlers, req)
    if (!res) throw new Error(`no mock handler for ${name} ${def.method} ${u.pathname}`)
    hit.add(name)
    if (def.response === 'sse') {
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
      await res.body?.cancel()
      return { status: res.status, data: null as any }
    }
    if (def.response === 'csv') {
      expect(res.headers.get('content-type')).toMatch(/text\/csv/)
      return { status: res.status, data: (await res.text()) as any }
    }
    const data = await res.json()
    if (res.ok) {
      const parsed = (def.response as z.ZodType).safeParse(data)
      expect(parsed.success, `${name}: ${JSON.stringify(parsed.error?.issues?.slice(0, 2))}`).toBe(true)
    } else {
      expect(ApiError.safeParse(data).success, `${name} error body is not an ApiError: ${JSON.stringify(data)}`).toBe(true)
    }
    return { status: res.status, data: data as any }
  }
  return { state, call, hit }
}

async function signIn(h: ReturnType<typeof harness>, seed?: string) {
  const s = mockRawSigner(seed)
  const n = await h.call('authNonce', { body: { address: s.address, publicKey: s.publicKey } })
  expect(n.status).toBe(200)
  const signature = await signMessage(s.rawSign, n.data.message)
  const sess = await h.call('authSession', { body: { address: s.address, publicKey: s.publicKey, nonce: n.data.nonce, signature } })
  expect(sess.status).toBe(200)
  return { signer: s, token: sess.data.token as string, user: sess.data.user }
}

async function signUp(h: ReturnType<typeof harness>, handle: string, role: 'user' | 'merchant' = 'user', seed?: string) {
  const { signer, token } = await signIn(h, seed)
  const prep = await h.call('onboardingPrepare', {
    token,
    body: { address: signer.address, publicKey: signer.publicKey, handle, displayName: handle[0].toUpperCase() + handle.slice(1), role, ...(role === 'merchant' ? { businessName: 'Caffè Test' } : {}) },
  })
  expect(prep.status).toBe(200)
  const signed = await signer.sign(prep.data.tx)
  const sub = await h.call('txSubmit', { token, body: { prepareId: prep.data.prepareId, txBlob: signed.tx_blob } })
  expect(sub.data.status).toBe('validated')
  return { signer, token, user: sub.data.user }
}

describe('mock API handlers vs the contracts', () => {
  it('serves every route in the table with a response that matches its schema', async () => {
    const h = harness({ features: ALL_FEATURES_ON })
    await h.call('health')
    const cfg = await h.call('config')
    expect(cfg.data.signerMode).toBe('mock')

    expect((await h.call('handleAvailable', { query: { handle: 'ana' } })).data).toEqual({ available: true })
    expect((await h.call('handleAvailable', { query: { handle: 'carla' } })).data.available).toBe(false)

    const ana = await signUp(h, 'ana')
    expect(ana.user.handle).toBe('ana')
    const bruno = await signUp(h, 'brunobar', 'merchant')
    const t = ana.token

    expect((await h.call('me', { token: t })).data.handle).toBe('ana')
    const bal = await h.call('balance', { token: t })
    expect(bal.data.availableMinor).toBe(fx.config.welcomeCreditMinor)
    expect((await h.call('resolve', { token: t, query: { q: '@carla' } })).data.kind).toBe('zecca')
    expect((await h.call('resolve', { token: t, query: { q: mockRawSigner().address } })).data.kind).toBe('external')
    expect((await h.call('resolve', { token: t, query: { q: 'nobody_here' } })).data.kind).toBe('unknown')

    const tr = await h.call('transferCreate', { token: t, body: { to: fx.users.carla.id, amountMinor: 1200, note: 'Dinner' } })
    const signed = await ana.signer.sign(tr.data.prepared.tx)
    const sub = await h.call('txSubmit', { token: t, body: { prepareId: tr.data.prepared.prepareId, txBlob: signed.tx_blob } })
    expect(sub.data.status).toBe('validated')
    await h.state.settle()
    expect((await h.call('transferGet', { token: t, params: { id: tr.data.intent.id } })).data.status).toBe('paid_out')
    const act = await h.call('activity', { token: t, query: { limit: '10' } })
    expect((await h.call('activityGet', { token: t, params: { id: act.data.items[0].id } })).data.id).toBe(act.data.items[0].id)
    expect(act.data.items.map((a: { kind: string }) => a.kind)).toEqual(['p2p', 'welcome'])
    expect((await h.call('contacts', { token: t })).data.map((p: { handle: string }) => p.handle)).toContain('carla')

    const pr = await h.call('paymentRequestCreate', { token: bruno.token, body: { amountMinor: 450, reference: 'Table 4' } })
    expect((await h.call('paymentRequestGet', { params: { id: pr.data.id }, token: t })).data.status).toBe('opened')
    await h.call('paymentRequestEvents', { params: { id: pr.data.id } })
    const pay = await h.call('paymentRequestPay', { token: t, params: { id: pr.data.id } })
    const paySigned = await ana.signer.sign(pay.data.prepared.tx)
    await h.call('txSubmit', { token: t, body: { prepareId: pay.data.prepared.prepareId, txBlob: paySigned.tx_blob } })
    await h.state.settle()
    expect((await h.call('paymentRequestGet', { params: { id: pr.data.id } })).data.status).toBe('paid')
    const again = await h.call('paymentRequestPay', { token: t, params: { id: pr.data.id } })
    expect(again.status).toBe(409)
    const pr2 = await h.call('paymentRequestCreate', { token: bruno.token, body: { amountMinor: 300 } })
    expect((await h.call('paymentRequestCancel', { token: bruno.token, params: { id: pr2.data.id } })).data.status).toBe('cancelled')
    const sales = await h.call('sales', { token: bruno.token })
    expect(sales.data.totals.count).toBe(1)
    expect((await h.call('salesCsv', { token: bruno.token })).data).toMatch(/^"Time","Customer"/)
    await h.call('events', { token: t, query: { token: t } })

    await h.call('rampSession', { token: t, body: { direction: 'buy', fiatAmount: 20, fiatCurrency: 'USD' } })
    await h.call('rampSign', { token: t, body: { url: 'https://buy-sandbox.moonpay.com/?a=1' } })
    await h.call('moonpayWebhook', { body: { type: 'transaction_updated' } })
    expect((await h.call('devCredit', { token: t, body: { amountMinor: 2500 } })).status).toBe(200)

    // phase 2, all from fixtures
    await h.call('cardCreate', { token: t })
    await h.call('cardGet', { token: t })
    await h.call('cardSecret', { token: t })
    await h.call('cardLoad', { token: t, body: { amountMinor: 1000 } })
    await h.call('cardFreeze', { token: t })
    await h.call('cardUnfreeze', { token: t })
    await h.call('lithicWebhook', { body: { token: 'x' } })
    await h.call('devCardSimulate', { token: t, body: { amountMinor: 3200, merchantName: 'Sette Archi' } })
    await h.call('shopItems')
    const order = await h.call('shopOrderCreate', { body: { items: [{ sku: 'guji-250', qty: 1 }] } })
    const shopOrder = await h.call('shopOrderGet', { params: { id: order.data.orderId } })
    expect(shopOrder.data).toMatchObject({ status: 'pending', paymentRequestId: order.data.paymentRequest.id, paymentStatus: order.data.paymentRequest.status, expiresAt: order.data.paymentRequest.expiresAt })
    await h.call('shopCharge', { body: { orderId: order.data.orderId, pan: '4111111111114417', expMonth: 11, expYear: 2029, cvc: '123' } })
    await h.call('earnPosition', { token: t })
    await h.call('earnDeposit', { token: t, body: { amountMinor: 1000 } })
    await h.call('earnWithdraw', { token: t, body: { amountDrops: 1_000_000 } })
    const idv = await h.call('identitySessionCreate', { token: t })
    await h.call('identitySessionGet', { token: t, params: { id: idv.data.id } })
    await h.call('marketAssets', { token: t })
    await h.call('marketHoldings', { token: t })
    await h.call('marketOrder', { token: t, body: { symbol: 'XAU', side: 'buy', amountMinor: 1000 } })
    const disc = await h.call('disclosureCreate', { token: t, body: { activityIds: ['act_1'] } })
    await h.call('disclosureGet', { params: { id: disc.data.id } })

    // Zecca Till: a code, pairing, a charge, reading and cancelling it, the list, unpairing
    const code = await h.call('tillPairingCreate', { token: bruno.token })
    expect(code.data.qrPayload).toBe(`zecca-till://pair?api=${encodeURIComponent(ORIGIN)}&code=${code.data.pairingCode}`)
    const till = await h.call('tillPair', { body: { code: code.data.pairingCode, name: 'Pixel 8' } })
    expect(till.data.merchantName).toBe('Caffè Test')
    const charge = await h.call('tillChargeCreate', { token: till.data.tillToken, body: { amountMinor: 450, reference: 'Table 4' } })
    expect((await h.call('tillChargeGet', { token: till.data.tillToken, params: { id: charge.data.id } })).data.status).toBe('created')
    expect((await h.call('tillChargeCancel', { token: till.data.tillToken, params: { id: charge.data.id } })).data.status).toBe('cancelled')
    expect((await h.call('tillList', { token: bruno.token })).data.items.map((x: { name: string }) => x.name)).toEqual(['Pixel 8'])
    expect((await h.call('tillRevoke', { token: bruno.token, params: { id: till.data.tillId } })).data).toEqual({ ok: true })

    const missing = (Object.keys(routes) as RouteName[]).filter((n) => !h.hit.has(n))
    expect(missing).toEqual([])
  })

  it('refuses without a session, and merchant routes for a plain user', async () => {
    const h = harness()
    expect((await h.call('me')).status).toBe(401)
    const { token } = await signIn(h)
    expect((await h.call('me', { token })).status).toBe(404) // signed in, not signed up
    const u = await signUp(h, 'dario')
    expect((await h.call('paymentRequestCreate', { token: u.token, body: { amountMinor: 100 } })).status).toBe(403)
  })

  it('Zecca Till: a code pairs once, the till token only works on the till routes, and stops at once when unpaired', async () => {
    const h = harness()
    const bruno = await signUp(h, 'brunobar', 'merchant')
    const ana = await signUp(h, 'anna')
    expect((await h.call('tillPairingCreate', { token: ana.token })).status).toBe(403)
    const code = await h.call('tillPairingCreate', { token: bruno.token })
    const typed = `${code.data.pairingCode.slice(0, 4).toLowerCase()}-${code.data.pairingCode.slice(4)}`
    const till = await h.call('tillPair', { body: { code: typed } })
    expect(till.status).toBe(200)
    const again = await h.call('tillPair', { body: { code: code.data.pairingCode } })
    expect(again.status).toBe(400)
    expect(again.data.error.message).toBe('This code is not valid or has expired. Show a new one in your Zecca merchant space.')

    const t = till.data.tillToken as string
    for (const name of ['me', 'balance', 'activity', 'sales', 'tillList'] as const) expect((await h.call(name, { token: t })).status, name).toBe(401)
    expect((await h.call('transferCreate', { token: t, body: { to: fx.users.carla.id, amountMinor: 100 } })).status).toBe(401)
    expect((await h.call('tillChargeCreate', { token: bruno.token, body: { amountMinor: 100 } })).status).toBe(401)
    const web = await h.call('paymentRequestCreate', { token: bruno.token, body: { amountMinor: 200 } })
    expect((await h.call('tillChargeGet', { token: t, params: { id: web.data.id } })).status).toBe(404)

    const charge = await h.call('tillChargeCreate', { token: t, body: { amountMinor: 450 } })
    expect(charge.data).toMatchObject({ status: 'created', merchantName: 'Caffè Test', amountMinor: 450 })
    expect((await h.call('tillList', { token: bruno.token })).data.items[0]).toMatchObject({ name: 'Till', lastSeenAt: expect.any(String) })
    await h.call('tillRevoke', { token: bruno.token, params: { id: till.data.tillId } })
    expect((await h.call('tillChargeGet', { token: t, params: { id: charge.data.id } })).status).toBe(401)
    expect((await h.call('tillList', { token: bruno.token })).data.items).toEqual([])
  })

  it('hides features that are off (404 feature_off)', async () => {
    const h = harness()
    const u = await signUp(h, 'elena')
    const r = await h.call('cardGet', { token: u.token })
    expect(r.status).toBe(404)
    expect(r.data.error.code).toBe('feature_off')
  })

  it('refuses a bad nonce signature and a blob that is not the prepared transaction', async () => {
    const h = harness()
    const s = mockRawSigner()
    const n = await h.call('authNonce', { body: { address: s.address, publicKey: s.publicKey } })
    const other = mockRawSigner()
    const bad = await signMessage(other.rawSign, n.data.message)
    const r = await h.call('authSession', { body: { address: s.address, publicKey: s.publicKey, nonce: n.data.nonce, signature: bad } })
    expect(r.status).toBe(401)
    expect(r.data.error.code).toBe('signature_invalid')

    const { signer, token } = await signIn(h)
    const prep = await h.call('onboardingPrepare', { token, body: { address: signer.address, publicKey: signer.publicKey, handle: 'fede', displayName: 'Fede', role: 'user' } })
    const tampered = await signer.sign({ ...prep.data.tx, Sequence: (prep.data.tx.Sequence as number) + 1 })
    const sub = await h.call('txSubmit', { token, body: { prepareId: prep.data.prepareId, txBlob: tampered.tx_blob } })
    expect(sub.status).toBe(400)
    expect(sub.data.error.code).toBe('policy_refused')
  })

  it('applies tier 0 limits and insufficient funds with details', async () => {
    const h = harness()
    const u = await signUp(h, 'gina')
    const lim = await h.call('transferCreate', { token: u.token, body: { to: fx.users.carla.id, amountMinor: 6000 } })
    expect(lim.status).toBe(403)
    expect(lim.data.error.code).toBe('limit_reached')
    expect(lim.data.error.details.limit).toBe('per_payment')
    expect(lim.data.error.details.capMinor).toBe(5000)
  })

  it('takes a handle once', async () => {
    const h = harness()
    await signUp(h, 'hana')
    const { signer, token } = await signIn(h)
    const r = await h.call('onboardingPrepare', { token, body: { address: signer.address, publicKey: signer.publicKey, handle: 'hana', displayName: 'Hana', role: 'user' } })
    expect(r.status).toBe(409)
    expect(r.data.error.code).toBe('handle_taken')
  })

  it('identity: pending for a moment, then verified with a CredentialAccept to approve; approving it lifts the tier', async () => {
    const h = harness({ features: { identity: true }, delays: { submitMs: 0, receiveMs: 0, payoutMs: 0, networkMs: 0, identityMs: 40 } })
    const u = await signUp(h, 'jana')
    expect(u.user.tier).toBe(0)
    const s = await h.call('identitySessionCreate', { token: u.token })
    expect(s.status).toBe(200)
    expect((await h.call('identitySessionGet', { token: u.token, params: { id: s.data.id } })).data).toEqual({ status: 'pending' })
    await new Promise((r) => setTimeout(r, 60))
    const v = await h.call('identitySessionGet', { token: u.token, params: { id: s.data.id } })
    expect(v.data).toMatchObject({ status: 'verified', identity: { over18: true }, prepared: { kind: 'credential_accept', tx: { TransactionType: 'CredentialAccept', Account: u.signer.address } } })
    // The same approval until it is used.
    expect((await h.call('identitySessionGet', { token: u.token, params: { id: s.data.id } })).data.prepared.prepareId).toBe(v.data.prepared.prepareId)
    const signed = await u.signer.sign(v.data.prepared.tx)
    const sub = await h.call('txSubmit', { token: u.token, body: { prepareId: v.data.prepared.prepareId, txBlob: signed.tx_blob } })
    expect(sub.data).toMatchObject({ status: 'validated', user: { tier: 1 } })
    expect((await h.call('me', { token: u.token })).data.tier).toBe(1)
    const after = await h.call('identitySessionGet', { token: u.token, params: { id: s.data.id } })
    expect(after.data.status).toBe('verified')
    expect(after.data.prepared).toBeUndefined()
  })

  it('identity: another person\'s session, or an unknown one, is not found', async () => {
    const h = harness({ features: { identity: true } })
    const a = await signUp(h, 'kira')
    const b = await signUp(h, 'luca')
    const s = await h.call('identitySessionCreate', { token: a.token })
    expect((await h.call('identitySessionGet', { token: b.token, params: { id: s.data.id } })).status).toBe(404)
    expect((await h.call('identitySessionGet', { token: a.token, params: { id: 'idv_nope' } })).status).toBe(404)
  })

  it('restores the same user when the same key signs in again', async () => {
    const h = harness()
    const first = await signUp(h, 'ivo')
    const again = await signIn(h, first.signer.seed)
    expect(again.user?.handle).toBe('ivo')
  })
})
