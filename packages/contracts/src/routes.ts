import { z } from 'zod'
import * as A from './api'
import { PublicConfig } from './config'
import { Balance, Intent, PaymentRequest, PreparedTx, User, Card, CardSecret } from './domain'

/**
 * The route table: the single source of truth for the HTTP API (base path /v1).
 * - auth: 'public' (no session), 'user' (Bearer session), 'merchant' (session with role merchant),
 *         'webhook' (public, vendor signature checked), 'demo' (public, only when DEMO_MODE=1),
 *         'dev' (session, only when DEMO_MODE=1)
 * - feature: the flag that must be on, otherwise 404 feature_off
 * - body / query: request schemas; response: the 2xx body schema ('sse' and 'csv' are streams)
 * The API's contract tests and the web's MSW handlers both iterate this table.
 */
export type RouteAuth = 'public' | 'user' | 'merchant' | 'webhook' | 'demo' | 'dev'
export type RouteDef = {
  method: 'GET' | 'POST'
  path: string
  auth: RouteAuth
  feature?: string
  phase: 1 | 2
  body?: z.ZodType
  query?: z.ZodType
  response: z.ZodType | 'sse' | 'csv' | 'html'
}

const r = <T extends RouteDef>(d: T) => d

export const routes = {
  health: r({ method: 'GET', path: '/v1/health', auth: 'public', phase: 1, response: A.HealthResponse }),
  config: r({ method: 'GET', path: '/v1/config', auth: 'public', phase: 1, response: PublicConfig }),
  authNonce: r({ method: 'POST', path: '/v1/auth/nonce', auth: 'public', phase: 1, body: A.AuthNonceRequest, response: A.AuthNonceResponse }),
  authSession: r({ method: 'POST', path: '/v1/auth/session', auth: 'public', phase: 1, body: A.AuthSessionRequest, response: A.AuthSessionResponse }),
  handleAvailable: r({ method: 'GET', path: '/v1/directory/handle-available', auth: 'public', phase: 1, query: A.HandleAvailableQuery, response: A.HandleAvailableResponse }),
  onboardingPrepare: r({ method: 'POST', path: '/v1/onboarding/prepare', auth: 'user', phase: 1, body: A.OnboardingPrepareRequest, response: PreparedTx }),
  txSubmit: r({ method: 'POST', path: '/v1/tx/submit', auth: 'user', phase: 1, body: A.TxSubmitRequest, response: A.TxSubmitResponse }),
  me: r({ method: 'GET', path: '/v1/me', auth: 'user', phase: 1, response: User }),
  balance: r({ method: 'GET', path: '/v1/balance', auth: 'user', phase: 1, response: Balance }),
  resolve: r({ method: 'GET', path: '/v1/directory/resolve', auth: 'user', phase: 1, query: A.ResolveQuery, response: A.ResolveResponse }),
  contacts: r({ method: 'GET', path: '/v1/contacts', auth: 'user', phase: 1, response: A.ContactsResponse }),
  transferCreate: r({ method: 'POST', path: '/v1/transfers', auth: 'user', phase: 1, body: A.TransferRequest, response: A.IntentWithPrepared }),
  transferGet: r({ method: 'GET', path: '/v1/transfers/:id', auth: 'user', phase: 1, response: Intent }),
  activity: r({ method: 'GET', path: '/v1/activity', auth: 'user', phase: 1, query: A.ActivityQuery, response: A.ActivityPage }),
  paymentRequestCreate: r({ method: 'POST', path: '/v1/payment-requests', auth: 'merchant', phase: 1, body: A.PaymentRequestCreate, response: PaymentRequest }),
  paymentRequestGet: r({ method: 'GET', path: '/v1/payment-requests/:id', auth: 'public', phase: 1, response: PaymentRequest }),
  paymentRequestEvents: r({ method: 'GET', path: '/v1/payment-requests/:id/events', auth: 'public', phase: 1, response: 'sse' }),
  paymentRequestPay: r({ method: 'POST', path: '/v1/payment-requests/:id/pay', auth: 'user', phase: 1, response: A.IntentWithPrepared }),
  paymentRequestCancel: r({ method: 'POST', path: '/v1/payment-requests/:id/cancel', auth: 'merchant', phase: 1, response: PaymentRequest }),
  sales: r({ method: 'GET', path: '/v1/merchant/sales', auth: 'merchant', phase: 1, query: A.SalesQuery, response: A.SalesResponse }),
  salesCsv: r({ method: 'GET', path: '/v1/merchant/sales.csv', auth: 'merchant', phase: 1, query: A.SalesQuery, response: 'csv' }),
  events: r({ method: 'GET', path: '/v1/events', auth: 'user', phase: 1, response: 'sse' }),
  rampSession: r({ method: 'POST', path: '/v1/ramp/session', auth: 'user', feature: 'ramp', phase: 1, body: A.RampSessionRequest, response: A.RampSessionResponse }),
  rampSign: r({ method: 'POST', path: '/v1/ramp/sign', auth: 'user', feature: 'ramp', phase: 1, body: A.RampSignRequest, response: A.RampSignResponse }),
  moonpayWebhook: r({ method: 'POST', path: '/v1/webhooks/moonpay', auth: 'webhook', phase: 1, response: A.Ok }),
  devCredit: r({ method: 'POST', path: '/v1/dev/credit', auth: 'dev', phase: 1, body: A.DevCreditRequest, response: Intent }),

  // ---------- phase 2 ----------
  cardCreate: r({ method: 'POST', path: '/v1/card', auth: 'user', feature: 'card', phase: 2, response: Card }),
  cardGet: r({ method: 'GET', path: '/v1/card', auth: 'user', feature: 'card', phase: 2, response: A.CardDetails }),
  cardSecret: r({ method: 'GET', path: '/v1/card/secret', auth: 'user', feature: 'card', phase: 2, response: CardSecret }),
  cardLoad: r({ method: 'POST', path: '/v1/card/load', auth: 'user', feature: 'card', phase: 2, body: A.CardLoadRequest, response: A.IntentWithPrepared }),
  cardFreeze: r({ method: 'POST', path: '/v1/card/freeze', auth: 'user', feature: 'card', phase: 2, response: Card }),
  cardUnfreeze: r({ method: 'POST', path: '/v1/card/unfreeze', auth: 'user', feature: 'card', phase: 2, response: Card }),
  lithicWebhook: r({ method: 'POST', path: '/v1/webhooks/lithic/asa', auth: 'webhook', phase: 2, response: z.object({ token: z.string(), result: z.string() }) }),
  devCardSimulate: r({ method: 'POST', path: '/v1/dev/card/simulate', auth: 'dev', feature: 'card', phase: 2, body: A.DevCardSimulateRequest, response: A.DevCardSimulateResponse }),
  shopItems: r({ method: 'GET', path: '/v1/demo/shop/items', auth: 'demo', feature: 'demoShop', phase: 1, response: z.array(A.ShopItem) }),
  shopOrderCreate: r({ method: 'POST', path: '/v1/demo/shop/orders', auth: 'demo', feature: 'demoShop', phase: 1, body: A.ShopOrderCreate, response: A.ShopOrderCreated }),
  shopOrderGet: r({ method: 'GET', path: '/v1/demo/shop/orders/:id', auth: 'demo', feature: 'demoShop', phase: 1, response: A.ShopOrder }),
  shopCharge: r({ method: 'POST', path: '/v1/demo/shop/charge', auth: 'demo', feature: 'card', phase: 2, body: A.ShopCharge, response: A.ShopChargeResponse }),
  earnPosition: r({ method: 'GET', path: '/v1/earn/position', auth: 'user', feature: 'earn', phase: 2, response: EarnPositionRef() }),
  earnDeposit: r({ method: 'POST', path: '/v1/earn/deposits', auth: 'user', feature: 'earn', phase: 2, body: A.EarnDepositRequest, response: A.EarnDepositResponse }),
  earnWithdraw: r({ method: 'POST', path: '/v1/earn/withdrawals', auth: 'user', feature: 'earn', phase: 2, body: A.EarnWithdrawRequest, response: A.EarnWithdrawResponse }),
  identitySessionCreate: r({ method: 'POST', path: '/v1/identity/sessions', auth: 'user', feature: 'identity', phase: 2, response: A.IdentitySession }),
  identitySessionGet: r({ method: 'GET', path: '/v1/identity/sessions/:id', auth: 'user', feature: 'identity', phase: 2, response: A.IdentitySessionStatus }),
  marketAssets: r({ method: 'GET', path: '/v1/market/assets', auth: 'user', feature: 'market', phase: 2, response: A.MarketAssetsResponse }),
  marketHoldings: r({ method: 'GET', path: '/v1/market/holdings', auth: 'user', feature: 'market', phase: 2, response: A.HoldingsResponse }),
  marketOrder: r({ method: 'POST', path: '/v1/market/orders', auth: 'user', feature: 'market', phase: 2, body: A.MarketOrderRequest, response: A.MarketOrderResponse }),
  disclosureCreate: r({ method: 'POST', path: '/v1/disclosures', auth: 'user', feature: 'proofs', phase: 2, body: A.DisclosureRequest, response: A.DisclosureResponse }),
  disclosureGet: r({ method: 'GET', path: '/v1/disclosures/:id', auth: 'public', feature: 'proofs', phase: 2, response: A.DisclosureStatement }),
} as const satisfies Record<string, RouteDef>

export type RouteName = keyof typeof routes

import { EarnPosition } from './domain'
function EarnPositionRef() {
  return EarnPosition
}

/** Fill `:params` in a route path. */
export function routePath(name: RouteName, params: Record<string, string> = {}): string {
  return routes[name].path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
    const v = params[k]
    if (v === undefined) throw new Error(`missing route param ${k} for ${name}`)
    return encodeURIComponent(v)
  })
}

/** Match a concrete path against the table, e.g. ('GET', '/v1/transfers/abc') -> { name: 'transferGet', params: { id: 'abc' } } */
export function matchRoute(method: string, pathname: string): { name: RouteName; params: Record<string, string> } | null {
  for (const [name, def] of Object.entries(routes) as [RouteName, RouteDef][]) {
    if (def.method !== method) continue
    const keys: string[] = []
    const re = new RegExp('^' + def.path.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), '([^/]+)')).replace(/\./g, '\\.') + '$')
    const m = re.exec(pathname)
    if (m) return { name, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }
  }
  return null
}

export type ResponseOf<N extends RouteName> = (typeof routes)[N]['response'] extends z.ZodType ? z.infer<(typeof routes)[N]['response']> : string
export type BodyOf<N extends RouteName> = (typeof routes)[N] extends { body: z.ZodType } ? z.input<(typeof routes)[N]['body']> : never
export type QueryOf<N extends RouteName> = (typeof routes)[N] extends { query: z.ZodType } ? z.input<(typeof routes)[N]['query']> : never
