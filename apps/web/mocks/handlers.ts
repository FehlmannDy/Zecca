// MSW handlers for every route in the contracts route table, served from the mock state.
import { delay, http, HttpResponse, sse, type HttpHandler } from 'msw'
import { routes, splitUsd, type RouteDef, type RouteName, type ZeccaEvent } from '@zecca/contracts'
import * as fx from '@zecca/contracts/fixtures'
import { sha512Half, verifyMessage } from '@zecca/xrpl-core/signer'
import { decode, encodeForSigning } from 'ripple-binary-codec'
import { deriveAddress, verify } from 'ripple-keypairs'
import type { z } from 'zod'
import { MockApiError, randomId, type MockState } from './state'

type Ctx = { request: Request; params: Record<string, string>; url: URL; token: string | null; body: any }
type Resolver = (ctx: Ctx) => unknown | Promise<unknown>

const bearer = (r: Request) => r.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null
const errorBody = (code: string, message: string, details?: Record<string, unknown>) => ({ error: { code, message, ...(details ? { details } : {}) } })

export function createHandlers(state: MockState, origin: string): HttpHandler[] {
  const { fail } = state
  const feature = (name: RouteName) => (routes[name] as RouteDef).feature

  const impl: Record<Exclude<RouteName, 'events' | 'paymentRequestEvents'>, Resolver> = {
    health: () => ({ ok: true, ledger: 'mock', version: 'mock' }),
    config: () => state.config,
    authNonce: ({ body }) => state.newNonce(body.address, body.publicKey),
    authSession: ({ body }) => {
      if ('privyToken' in body) {
        // Mock mode only: the real API verifies the Privy JWT against Privy's JWKS.
        return state.openSession(body.address, body.publicKey)
      }
      const n = state.takeNonce(body.nonce)
      const keyOk = (() => {
        try {
          return deriveAddress(body.publicKey) === body.address
        } catch {
          return false
        }
      })()
      if (n.address !== body.address || !keyOk || !verifyMessage(n.message, body.signature, body.publicKey))
        fail(401, 'signature_invalid', "We couldn't confirm it's you. Try signing in again.")
      return state.openSession(body.address, body.publicKey)
    },
    handleAvailable: ({ url }) => {
      const h = url.searchParams.get('handle') ?? ''
      if (!/^[a-z0-9_]{3,20}$/.test(h)) return { available: false, reason: 'Handles are 3 to 20 characters: lowercase letters, digits and _.' }
      return state.handleTaken(h) ? { available: false, reason: 'Taken, try another.' } : { available: true }
    },
    onboardingPrepare: ({ token, body }) => state.prepareOnboarding(token!, body),
    txSubmit: async ({ token, body }) => {
      const s = state.sessionOf(token)
      const row = state.preparedRow(body.prepareId)
      if (!row || row.token !== token) fail(404, 'not_found', 'This approval has expired. Start again.')
      if (row.used) fail(409, 'conflict', 'This approval was already used.')
      if (Date.parse(row.prepared.expiresAt) < Date.now()) fail(410, 'expired', 'This approval has expired. Start again.')
      // Same check as the API (D11): the blob is exactly the prepared tx, signed by the session's key.
      let decoded: Record<string, unknown>
      try {
        decoded = decode(body.txBlob) as Record<string, unknown>
      } catch {
        return fail(400, 'bad_request', "That approval couldn't be read. Try again.")
      }
      const { TxnSignature, ...unsigned } = decoded
      const expected = encodeForSigning({ ...row.prepared.tx, SigningPubKey: s.publicKey } as never)
      if (encodeForSigning(unsigned as never) !== expected) fail(400, 'policy_refused', 'This approval does not match the payment. Start again.')
      if (typeof TxnSignature !== 'string' || !verify(expected, TxnSignature, s.publicKey)) fail(400, 'signature_invalid', "We couldn't confirm your approval. Try again.")
      const hash = sha512Half('54584E00' + body.txBlob)
      return state.completeSubmit(token!, body.prepareId, hash)
    },
    me: ({ token }) => state.userOf(token),
    balance: ({ token }) => state.balanceOf(state.userOf(token).id),
    resolve: ({ token, url }) => (state.userOf(token), state.resolve(url.searchParams.get('q') ?? '')),
    contacts: ({ token }) => state.contacts(state.userOf(token)),
    transferCreate: ({ token, body }) => state.createTransfer(token!, body.to, body.amountMinor, body.note),
    transferGet: ({ token, params }) => state.intent(token!, params.id),
    activityGet: ({ token, params }) => state.activityOne(state.userOf(token), params.id),
    activity: ({ token, url }) => state.activityPage(state.userOf(token), url.searchParams.get('cursor') ?? undefined, Number(url.searchParams.get('limit') ?? 20)),
    paymentRequestCreate: ({ token, body }) => state.createRequest(token!, body.amountMinor, body.reference),
    paymentRequestGet: ({ token, params }) => state.readRequest(params.id, token),
    paymentRequestPay: ({ token, params }) => state.payRequest(token!, params.id),
    paymentRequestCancel: ({ token, params }) => state.cancelRequest(token!, params.id),
    sales: ({ token, url }) => state.sales(token!, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined),
    salesCsv: ({ token, url }) => {
      const { items } = state.sales(token!, url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined)
      const cents = (m: number) => {
        const { dollars, cents: c } = splitUsd(m)
        return `${dollars.replace(/,/g, '')}.${c}`
      }
      const rows = [['Time', 'Customer', 'Reference', 'Amount', 'Fee', 'Net', 'Payout'], ...items.map((s) => [s.paidAt, s.payer?.displayName ?? 'Customer', s.reference ?? '', cents(s.amountMinor), cents(s.feeMinor), cents(s.netMinor), s.payoutStatus === 'done' ? 'Paid out' : 'Paying out'])]
      return new HttpResponse(rows.map((r) => r.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(',')).join('\r\n'), { headers: { 'content-type': 'text/csv; charset=utf-8' } })
    },
    rampSession: ({ token, body }) => {
      const u = state.userOf(token)
      // Mock delivery: the purchase "lands" a few seconds later, scaled like the sandbox.
      const minor = Math.round((body.fiatAmount ?? 20) * 100)
      state.later(6000, () => state.credit(u, minor, 'topup', undefined, 'testnet'))
      return { ...fx.rampSession, externalId: randomId('rmp') }
    },
    rampSign: () => ({ signature: 'mock-signature' }),
    moonpayWebhook: () => ({ ok: true }),
    devCredit: ({ token, body }) => state.credit(state.userOf(token), body.amountMinor, 'topup', 'Demo credit'),
    cardCreate: ({ token }) => (state.userOf(token), state.setCard('OPEN'), { ...fx.card, state: 'OPEN' }),
    cardGet: ({ token }) => (state.userOf(token), { ...fx.cardDetails, state: state.card()?.state ?? 'OPEN' }),
    cardSecret: ({ token }) => (state.userOf(token), fx.cardSecret),
    cardLoad: ({ token, body }) => (state.userOf(token), { intent: { ...fx.intents.p2pCreated, id: randomId('int'), kind: 'card_load', amountMinor: body.amountMinor, toUserId: undefined, note: undefined }, prepared: fx.preparedSend }),
    cardFreeze: ({ token }) => (state.userOf(token), state.setCard('PAUSED'), { ...fx.card, state: 'PAUSED' }),
    cardUnfreeze: ({ token }) => (state.userOf(token), state.setCard('OPEN'), { ...fx.card, state: 'OPEN' }),
    lithicWebhook: ({ body }) => ({ token: String(body?.token ?? 'mock'), result: 'APPROVED' }),
    devCardSimulate: ({ token, body }) => (state.userOf(token), { approved: body.amountMinor <= fx.cardDetails.balanceMinor, authorization: { id: randomId('auth'), amountMinor: body.amountMinor, merchant: body.merchantName, approved: body.amountMinor <= fx.cardDetails.balanceMinor, status: body.amountMinor <= fx.cardDetails.balanceMinor ? 'authorised' : 'declined', at: new Date().toISOString() } }),
    shopItems: () => fx.shopItems,
    shopOrderCreate: ({ body }) => {
      const items = (body.items as { sku: string; qty: number }[]).map((i) => {
        const item = fx.shopItems.find((s) => s.sku === i.sku) ?? fail(404, 'not_found', 'That item is no longer available.')
        return { ...item, qty: i.qty }
      })
      const amountMinor = items.reduce((s, i) => s + i.priceMinor * i.qty, 0)
      const shop = state.data().users.usr_shop
      const shopToken = state.openSession(shop.address, fx.PUBKEY.bruno).token
      const pr = state.createRequest(shopToken, amountMinor, 'Sette Archi order')
      return { orderId: pr.id.replace(/^pr_/, 'ord_'), amountMinor, paymentRequest: pr }
    },
    shopOrderGet: ({ params }) => {
      state.expireRequests()
      const pr = state.data().paymentRequests[params.id.replace(/^ord_/, 'pr_')]
      const order = { id: params.id, items: [{ sku: 'guji-250', name: 'Ethiopia Guji, 250 g', qty: 1, unitMinor: 1450 }], amountMinor: 1450, status: 'pending', createdAt: new Date().toISOString() }
      if (!pr) return order
      return { ...order, status: pr.status === 'paid' ? 'paid' : 'pending', ...(pr.status === 'paid' ? { method: 'zecca' } : {}), paymentRequestId: pr.id, paymentStatus: pr.status, expiresAt: pr.expiresAt }
    },
    shopCharge: ({ body }) => ({ approved: true, receipt: { ...fx.receipts.shopCard, reference: body.orderId } }),
    earnPosition: ({ token }) => (state.userOf(token), fx.earnPosition),
    earnDeposit: ({ token, body }) => (state.userOf(token), { intent: { ...fx.intents.p2pCreated, id: randomId('int'), kind: 'earn_deposit', amountMinor: body.amountMinor, toUserId: undefined, note: undefined }, prepared: fx.preparedSend, quote: { xrpDrops: Math.round((body.amountMinor / 220) * 1_000_000), rateMinorPerXrp: 220, swapFeeMinor: Math.floor((body.amountMinor * 30) / 10_000) } }),
    earnWithdraw: ({ token }) => (state.userOf(token), { status: 'requested', claimableAt: new Date(Date.now() + 4 * 3_600_000).toISOString() }),
    identitySessionCreate: ({ token }) => state.createIdentitySession(token!),
    identitySessionGet: ({ token, params }) => state.identitySession(token!, params.id),
    marketAssets: ({ token }) => (state.userOf(token), fx.marketAssets),
    marketHoldings: ({ token }) => (state.userOf(token), fx.holdings),
    marketOrder: ({ token, body }) => (state.userOf(token), { orderId: randomId('ord'), prepared: fx.preparedSend, quote: { quantityMg: 118, amountMinor: body.amountMinor ?? 1000, unitPriceMinor: 8454, spreadMinor: 10 } }),
    disclosureCreate: ({ token }) => (state.userOf(token), { id: fx.statement.id, url: `${state.config.webOrigin}/proofs/${fx.statement.id}` }),
    disclosureGet: () => fx.statement,
  }

  const handlers: HttpHandler[] = []

  for (const [name, resolver] of Object.entries(impl) as [RouteName, Resolver][]) {
    const def = routes[name]
    const method = def.method === 'GET' ? http.get : http.post
    handlers.push(
      method(origin + def.path, async ({ request, params }) => {
        if (state.delays.networkMs) await delay(state.delays.networkMs)
        const url = new URL(request.url)
        const token = bearer(request)
        try {
          const f = feature(name)
          if (f && !state.config.features[f as keyof typeof state.config.features]) fail(404, 'feature_off', 'This is not available yet.')
          if ((def.auth === 'dev' || def.auth === 'demo') && !state.config.demoMode) fail(404, 'not_found', 'Not found.')
          if (def.auth === 'user' || def.auth === 'merchant' || def.auth === 'dev') state.sessionOf(token)
          if (def.auth === 'merchant' && !state.userOf(token).role.includes('merchant')) fail(403, 'forbidden', 'Switch on your business account to do this.')
          let body: unknown
          if (def.method === 'POST') {
            const raw = await request.text()
            body = raw ? JSON.parse(raw) : {}
            if ('body' in def && def.body) {
              const parsed = (def.body as z.ZodType).safeParse(body)
              if (!parsed.success) fail(400, 'bad_request', parsed.error.issues[0]?.message ?? 'Check the details and try again.')
              body = parsed.data
            }
          }
          const out = await resolver({ request, params: params as Record<string, string>, url, token, body })
          return out instanceof Response ? out : HttpResponse.json(out as never)
        } catch (e) {
          if (e instanceof MockApiError) return HttpResponse.json(errorBody(e.code, e.message, e.details), { status: e.status })
          if (e instanceof SyntaxError) return HttpResponse.json(errorBody('bad_request', 'Check the details and try again.'), { status: 400 })
          console.error('[mock api]', name, e)
          return HttpResponse.json(errorBody('internal', 'Something went wrong on our side. Try again in a moment.'), { status: 500 })
        }
      }),
    )
  }

  // ---------- Server-Sent Events ----------
  const frame = (e: ZeccaEvent) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`
  const userStream = (token: string | null) => (push: (e: ZeccaEvent) => void) => state.subscribe(token!, push)
  const requestStream = (id: string) => (push: (e: ZeccaEvent) => void) => {
    const pr = state.data().paymentRequests[id]
    if (pr) push({ type: 'payment_request.updated', data: { ...pr }, at: new Date().toISOString() })
    return state.subscribeRequest(id, push)
  }
  const sseError = (status: number, code: string, message: string) => HttpResponse.json(errorBody(code, message), { status })

  if (typeof EventSource !== 'undefined') {
    // Browser: msw's sse() feeds the page's EventSource.
    handlers.unshift(
      sse(origin + routes.events.path, ({ client, request }) => {
        const token = new URL(request.url).searchParams.get('token')
        if (!token || !state.data().sessions[token]) return client.error()
        const off = userStream(token)((e) => client.send({ event: e.type, data: JSON.stringify(e) } as never))
        request.signal.addEventListener('abort', () => off())
      }) as HttpHandler,
      sse(origin + routes.paymentRequestEvents.path, ({ client, request, params }) => {
        const off = requestStream(String(params.id))((e) => client.send({ event: e.type, data: JSON.stringify(e) } as never))
        request.signal.addEventListener('abort', () => off())
      }) as HttpHandler,
    )
  }
  // Plain streams (Node, tests, and any client that does not send Accept: text/event-stream).
  const stream = (subscribe: (push: (e: ZeccaEvent) => void) => () => void) => {
    let off = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder()
        c.enqueue(enc.encode(': connected\n\n'))
        off = subscribe((e) => c.enqueue(enc.encode(frame(e))))
      },
      cancel() {
        off()
      },
    })
    return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
  }
  handlers.push(
    http.get(origin + routes.events.path, ({ request }) => {
      const url = new URL(request.url)
      const token = url.searchParams.get('token') ?? bearer(request)
      if (!token || !state.data().sessions[token]) return sseError(401, 'unauthorized', 'Your session has ended. Sign in again.')
      return stream(userStream(token))
    }),
    http.get(origin + routes.paymentRequestEvents.path, ({ params }) => stream(requestStream(String(params.id)))),
  )
  return handlers
}
