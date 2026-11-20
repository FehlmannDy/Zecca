// Lithic REST (sandbox only), behind an interface so unit tests run on a fake. Port of card-issuer/scripts/lithic-api.js.
// Auth: the raw API key in `Authorization`, no "Bearer" (https://docs.lithic.com/docs/api-basics, accessed 2026-11-20).
// Sandbox traps (HANDOFF card-issuer): simulate answers 201 even on a decline, so the decision is read from
// GET /v1/transactions/{token}; it is not readable at once (poll 250 ms, up to 5 s); simulate is limited to 1 call per second.

export const SANDBOX_URL = 'https://sandbox.lithic.com'

export type LithicCard = {
  token: string
  last4: string
  expMonth: number
  expYear: number
  state: string
  /** Only in sandbox responses. Never stored by Zecca. */
  pan?: string
  cvv?: string
}

export type LithicEvent = { token?: string; type: string; amount?: number; result?: string; detailed_results?: string[]; created?: string }
export type LithicTx = {
  token: string
  card_token?: string
  status: string
  result?: string
  amount?: number
  settled_amount?: number
  amounts?: { cardholder?: { amount?: number } }
  merchant?: { descriptor?: string }
  events?: LithicEvent[]
  created?: string
}

export interface LithicApi {
  readonly baseUrl: string
  createCard(o: { memo: string }): Promise<LithicCard>
  getCard(token: string): Promise<LithicCard>
  setCardState(token: string, state: 'OPEN' | 'PAUSED'): Promise<LithicCard>
  /** null while Lithic does not know the transaction yet. */
  getTransaction(token: string): Promise<LithicTx | null>
  listTransactions(o: { cardToken: string }): Promise<LithicTx[]>
  simulateAuthorize(o: { amount: number; descriptor: string; pan: string; mcc?: string }): Promise<{ token: string }>
  simulateClearing(o: { token: string; amount?: number }): Promise<void>
  simulateVoid(o: { token: string; amount?: number }): Promise<void>
  simulateReturn(o: { amount: number; descriptor: string; pan: string }): Promise<{ token: string }>
  /** GET /v1/auth_stream/secret: also switches signed ASA headers on (they start a few minutes later). */
  authStreamSecret(): Promise<string>
  enrollAsa(url: string): Promise<void>
  asaEnrollment(): Promise<unknown>
}

export class LithicError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'LithicError'
  }
}

type Json = Record<string, unknown>

const int = (v: unknown) => Number.parseInt(String(v ?? ''), 10)

function toCard(j: Json): LithicCard {
  return {
    token: String(j.token),
    last4: String(j.last_four ?? ''),
    expMonth: int(j.exp_month),
    expYear: int(j.exp_year),
    state: String(j.state ?? ''),
    ...(typeof j.pan === 'string' ? { pan: j.pan } : {}),
    ...(typeof j.cvv === 'string' ? { cvv: j.cvv } : {}),
  }
}

export function createLithicHttp(o: { apiKey: string | undefined; baseUrl?: string; fetch?: typeof fetch }): LithicApi {
  if (!o.apiKey) throw new Error('LITHIC_API_KEY is not set')
  const apiKey = o.apiKey
  const baseUrl = (o.baseUrl || SANDBOX_URL).replace(/\/+$/, '')
  // Same guard as the probe's scripts: Zecca's card is a sandbox card, never a live one.
  if (!/^https:\/\/sandbox\.lithic\.com$/.test(baseUrl)) throw new Error('Refusing a Lithic base URL that is not the sandbox')
  const doFetch = o.fetch ?? fetch

  async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await doFetch(baseUrl + path, {
      method,
      headers: { Authorization: apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: Json = {}
    try {
      json = text ? (JSON.parse(text) as Json) : {}
    } catch {
      json = {}
    }
    return { status: res.status, json }
  }
  async function ok(method: string, path: string, body?: unknown): Promise<Json> {
    const r = await call(method, path, body)
    if (r.status >= 200 && r.status < 300) return r.json
    // Lithic's message, without anything that could be the key.
    const why = typeof r.json.message === 'string' ? r.json.message.split(apiKey).join('[key]') : 'no message'
    const dbg = typeof r.json.debugging_request_id === 'string' ? ` (debugging id ${r.json.debugging_request_id})` : ''
    throw new LithicError(r.status, `Lithic ${method} ${path.split('?')[0]} -> HTTP ${r.status}: ${why}${dbg}`)
  }

  return {
    baseUrl,
    async createCard({ memo }) {
      return toCard(await ok('POST', '/v1/cards', { type: 'VIRTUAL', memo, state: 'OPEN' }))
    },
    async getCard(token) {
      return toCard(await ok('GET', `/v1/cards/${encodeURIComponent(token)}`))
    },
    async setCardState(token, state) {
      return toCard(await ok('PATCH', `/v1/cards/${encodeURIComponent(token)}`, { state }))
    },
    async getTransaction(token) {
      const r = await call('GET', `/v1/transactions/${encodeURIComponent(token)}`)
      if (r.status === 404) return null
      if (r.status < 200 || r.status >= 300) throw new LithicError(r.status, `Lithic GET /v1/transactions -> HTTP ${r.status}`)
      return r.json as unknown as LithicTx
    },
    async listTransactions({ cardToken }) {
      const j = await ok('GET', `/v1/transactions?card_token=${encodeURIComponent(cardToken)}&page_size=50`)
      return Array.isArray(j.data) ? (j.data as LithicTx[]) : []
    },
    async simulateAuthorize({ amount, descriptor, pan, mcc }) {
      const j = await ok('POST', '/v1/simulate/authorize', { amount, descriptor, pan, ...(mcc ? { mcc } : {}) })
      if (typeof j.token !== 'string') throw new LithicError(502, 'Lithic simulate/authorize returned no transaction token')
      return { token: j.token }
    },
    async simulateClearing({ token, amount }) {
      await ok('POST', '/v1/simulate/clearing', { token, ...(amount !== undefined ? { amount } : {}) })
    },
    async simulateVoid({ token, amount }) {
      await ok('POST', '/v1/simulate/void', { token, ...(amount !== undefined ? { amount } : {}) })
    },
    async simulateReturn({ amount, descriptor, pan }) {
      const j = await ok('POST', '/v1/simulate/return', { amount, descriptor, pan })
      return { token: String(j.token ?? '') }
    },
    async authStreamSecret() {
      const j = await ok('GET', '/v1/auth_stream/secret')
      if (typeof j.secret !== 'string' || !j.secret.startsWith('whsec_')) throw new LithicError(502, 'Lithic returned no ASA secret')
      return j.secret
    },
    async enrollAsa(url) {
      await ok('POST', '/v1/responder_endpoints', { type: 'AUTH_STREAM_ACCESS', url })
    },
    async asaEnrollment() {
      return ok('GET', '/v1/responder_endpoints?type=AUTH_STREAM_ACCESS')
    },
  }
}

export type Clock = { now?: () => number; sleep?: (ms: number) => Promise<void> }
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** One call at a time, starts at least `minMs` apart (the sandbox allows 1 simulate call per second). */
export function createGate(minMs: number, c: Clock = {}) {
  const now = c.now ?? Date.now
  const sleep = c.sleep ?? realSleep
  let chain: Promise<unknown> = Promise.resolve()
  let last = Number.NEGATIVE_INFINITY
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const p = chain.then(async () => {
        const wait = last + minMs - now()
        if (wait > 0) await sleep(wait)
        last = now()
        return fn()
      })
      chain = p.catch(() => undefined)
      return p
    },
  }
}

/** Reads the decision of a simulated purchase: GET the transaction every 250 ms until it carries a result, up to 5 s. */
export async function waitForResult(api: Pick<LithicApi, 'getTransaction'>, token: string, c: Clock & { intervalMs?: number; timeoutMs?: number } = {}): Promise<LithicTx> {
  const now = c.now ?? Date.now
  const sleep = c.sleep ?? realSleep
  const interval = c.intervalMs ?? 250
  const end = now() + (c.timeoutMs ?? 5000)
  for (;;) {
    const tx = await api.getTransaction(token)
    if (tx?.result) return tx
    if (now() + interval > end) throw new LithicError(504, `Lithic transaction ${token} has no result after ${c.timeoutMs ?? 5000} ms`)
    await sleep(interval)
  }
}
