// MoonPay sandbox helpers, ported from ../moonpay-ramp/lib/moonpay.mjs: URL signing, the allowedIpAddress hash,
// webhook verification, and the public API lookups. Keys are passed in (never read from process.env here) and never logged.
import { createHmac, timingSafeEqual } from 'node:crypto'

export const MOONPAY_API = 'https://api.moonpay.com'
export const WIDGET_HOSTS = { buy: 'buy-sandbox.moonpay.com', sell: 'sell-sandbox.moonpay.com' } as const
export type Flow = keyof typeof WIDGET_HOSTS
export type MoonPayKeys = { publishableKey: string; secretKey: string }

/** HMAC-SHA256 over the query string (with its leading '?'), secret key, base64. Raw: the web SDK encodes it itself. */
export function signQuery(secretKey: string, search: string): string {
  return createHmac('sha256', secretKey).update(search).digest('base64')
}

/** The IP as MoonPay hashes it: no port or brackets, IPv4 without leading zeros, v4-mapped unwrapped, IPv6 compressed. */
export function canonicalIp(ip: string): string {
  let s = String(ip).trim().replace(/^\[|\](:\d+)?$/g, '')
  if (/^\d+\.\d+\.\d+\.\d+(:\d+)?$/.test(s)) return s.replace(/:\d+$/, '').split('.').map(Number).join('.')
  s = s.toLowerCase().replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
  if (!s.includes(':')) return s
  return new URL(`http://[${s}]/`).hostname.slice(1, -1) // RFC 5952-style compression
}

/** `allowedIpAddress`: base64(HMAC-SHA256(secret, canonical IP)). The sandbox refuses a signed URL without it (5_PARTNERS_IP_MISSING). */
export function ipHash(secretKey: string, ip: string): string {
  return createHmac('sha256', secretKey).update(canonicalIp(ip)).digest('base64')
}

/** Full signed widget URL: values URL-encoded first, signature appended last. */
export function signedWidgetUrl(keys: MoonPayKeys, flow: Flow, params: Record<string, string | number | undefined | null>): string {
  const url = new URL(`https://${WIDGET_HOSTS[flow]}/`)
  for (const [k, v] of Object.entries({ apiKey: keys.publishableKey, ...params })) if (v != null) url.searchParams.set(k, String(v))
  return `${url.toString()}&signature=${encodeURIComponent(signQuery(keys.secretKey, url.search))}`
}

/** For logs: never print a usable signed URL. */
export const redactUrl = (u: string) => String(u).replace(/([?&]signature=)[^&]+/, '$1<redacted>')

export type WebhookCheck = { ok: true } | { ok: false; reason: string }

/**
 * Moonpay-Signature-V2: "t=<unix>,s=<hex hmac>", HMAC-SHA256(webhookKey, `${t}.${rawBody}`), timing-safe.
 * Hex is what MoonPay sends (12/12 real webhooks); base64 of the same MAC is accepted too. No key: always refused.
 */
export function verifyWebhookSignature(
  rawBody: string,
  header: string | undefined,
  key: string | undefined,
  opts: { toleranceSec?: number; nowMs?: number } = {},
): WebhookCheck {
  const toleranceSec = opts.toleranceSec ?? 600
  if (!key) return { ok: false, reason: 'MOONPAY_WEBHOOK_KEY not set' }
  if (!header) return { ok: false, reason: 'missing Moonpay-Signature-V2 header' }
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, ...v] = p.split('=').map((s) => s.trim())
      return [k, v.join('=')]
    }),
  )
  if (!parts.t || !parts.s) return { ok: false, reason: 'malformed header' }
  const mac = createHmac('sha256', key).update(`${parts.t}.${rawBody}`).digest()
  const given = /^[0-9a-f]{64}$/i.test(parts.s) ? Buffer.from(parts.s, 'hex') : Buffer.from(parts.s, 'base64')
  if (given.length !== mac.length || !timingSafeEqual(given, mac)) return { ok: false, reason: 'signature mismatch' }
  const age = Math.abs((opts.nowMs ?? Date.now()) / 1000 - Number(parts.t))
  if (!(age <= toleranceSec)) return { ok: false, reason: `timestamp outside tolerance (${Math.round(age)}s)` }
  return { ok: true }
}

// ---------- public API (publishable key as ?apiKey=; `Authorization: Api-Key <sk>` answers 401) ----------
export type ApiResult<T = any> = { status: number; body: T }

export type MoonPayCurrency = { code: string; isSuspended?: boolean; notAllowedCountries?: string[]; [k: string]: unknown }

export type MoonPayApi = {
  /** Country and public IP as MoonPay sees them. No ip: the caller's own public IP (a local browser shares it). */
  ipCountry(ip: string | undefined): Promise<ApiResult>
  getBuyTransaction(id: string): Promise<ApiResult>
  /** Buy transactions carrying our externalTransactionId (an array). */
  buyTransactionsByExternalId(externalId: string): Promise<ApiResult>
  /** One entry of the full /v3/currencies list, cached (there is no per-code endpoint). */
  currency(code: string): Promise<MoonPayCurrency | undefined>
}

export function createMoonPayApi(o: { publishableKey: string; fetch?: typeof fetch; base?: string }): MoonPayApi {
  const doFetch = o.fetch ?? fetch
  const base = o.base ?? MOONPAY_API
  async function getJson(path: string, params: Record<string, string | undefined> = {}): Promise<ApiResult> {
    const url = new URL(base + path)
    for (const [k, v] of Object.entries({ ...params, apiKey: o.publishableKey })) if (v != null) url.searchParams.set(k, v)
    const res = await doFetch(url, { headers: { accept: 'application/json' } })
    const text = await res.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
    return { status: res.status, body }
  }
  let currencies: Promise<MoonPayCurrency[]> | undefined
  return {
    ipCountry: (ipAddress) => getJson('/v3/ip_address', { ipAddress }),
    getBuyTransaction: (id) => getJson(`/v1/transactions/${encodeURIComponent(id)}`),
    buyTransactionsByExternalId: (id) => getJson(`/v1/transactions/ext/${encodeURIComponent(id)}`),
    async currency(code) {
      currencies ??= getJson('/v3/currencies')
        .then((r) => (r.status === 200 && Array.isArray(r.body) ? (r.body as MoonPayCurrency[]) : Promise.reject(new Error(`currencies ${r.status}`))))
        .catch((e) => {
          currencies = undefined
          throw e
        })
      return (await currencies).find((c) => c.code === code)
    },
  }
}
