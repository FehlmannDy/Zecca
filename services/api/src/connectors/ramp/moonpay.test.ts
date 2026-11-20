// Port of ../moonpay-ramp/scripts/selftest.mjs (offline vectors with dummy keys) plus the cases it never had.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalIp, createMoonPayApi, ipHash, redactUrl, signQuery, signedWidgetUrl, verifyWebhookSignature } from './moonpay'

const KEYS = { publishableKey: 'pk_test_DUMMY', secretKey: 'sk_test_DUMMY' }
const WK = 'wk_test_DUMMY'
const BODY = '{"type":"transaction_updated","data":{"id":"abc","status":"completed"}}'
const hexSig = (t: number, body: string, key = WK) => createHmac('sha256', key).update(`${t}.${body}`).digest('hex')

describe('verifyWebhookSignature (Moonpay-Signature-V2)', () => {
  it('matches the documented vector from MOONPAY_REPORT.md', () => {
    const t = 1795195908
    expect(hexSig(t, BODY)).toBe('3729cafce6e1cb121acc182a58e9434bdc5623b9743ddd5042abb7d28d4c5581')
    expect(verifyWebhookSignature(BODY, `t=${t},s=3729cafce6e1cb121acc182a58e9434bdc5623b9743ddd5042abb7d28d4c5581`, WK, { nowMs: t * 1000 })).toEqual({ ok: true })
  })

  it('accepts a fresh signature and refuses a tampered body, a wrong key, a stale time, a missing or malformed header', () => {
    const t = Math.floor(Date.now() / 1000)
    const s = hexSig(t, BODY)
    expect(verifyWebhookSignature(BODY, `t=${t},s=${s}`, WK)).toEqual({ ok: true })
    expect(verifyWebhookSignature(BODY + ' ', `t=${t},s=${s}`, WK)).toEqual({ ok: false, reason: 'signature mismatch' })
    expect(verifyWebhookSignature(BODY, `t=${t},s=${s}`, 'wk_test_OTHER')).toEqual({ ok: false, reason: 'signature mismatch' })
    const old = t - 3600
    const r = verifyWebhookSignature(BODY, `t=${old},s=${hexSig(old, BODY)}`, WK)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/tolerance/)
    expect(verifyWebhookSignature(BODY, undefined, WK)).toEqual({ ok: false, reason: 'missing Moonpay-Signature-V2 header' })
    expect(verifyWebhookSignature(BODY, 'garbage', WK)).toEqual({ ok: false, reason: 'malformed header' })
    expect(verifyWebhookSignature(BODY, `t=${t},s=`, WK)).toEqual({ ok: false, reason: 'malformed header' })
  })

  it('refuses everything when no webhook key is configured (never falls back to trusting the body)', () => {
    const t = Math.floor(Date.now() / 1000)
    expect(verifyWebhookSignature(BODY, `t=${t},s=${hexSig(t, BODY)}`, undefined)).toEqual({ ok: false, reason: 'MOONPAY_WEBHOOK_KEY not set' })
    expect(verifyWebhookSignature(BODY, `t=${t},s=${hexSig(t, BODY, '')}`, '')).toEqual({ ok: false, reason: 'MOONPAY_WEBHOOK_KEY not set' })
  })

  it('accepts the base64 form of the same MAC and a timestamp inside 600 s either way', () => {
    const t = 1795195908
    const b64 = createHmac('sha256', WK).update(`${t}.${BODY}`).digest('base64')
    expect(verifyWebhookSignature(BODY, `t=${t},s=${b64}`, WK, { nowMs: (t + 599) * 1000 })).toEqual({ ok: true })
    expect(verifyWebhookSignature(BODY, `t=${t},s=${b64}`, WK, { nowMs: (t - 599) * 1000 })).toEqual({ ok: true })
    expect(verifyWebhookSignature(BODY, `t=${t},s=${b64}`, WK, { nowMs: (t + 601) * 1000 }).ok).toBe(false)
  })
})

describe('URL signing', () => {
  it('signs ?query with HMAC-SHA256(secret) in base64, URL-encoded and appended last', () => {
    const url = signedWidgetUrl(KEYS, 'buy', {
      currencyCode: 'rlusd_xrp',
      walletAddress: 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS',
      baseCurrencyAmount: 30,
      externalCustomerId: 'user 1+x',
    })
    expect(url.startsWith('https://buy-sandbox.moonpay.com/?apiKey=pk_test_DUMMY&')).toBe(true)
    const sig = new URL(url).searchParams.get('signature')
    expect(sig).toBe(createHmac('sha256', 'sk_test_DUMMY').update(new URL(url.split('&signature=')[0]).search).digest('base64'))
    expect(url.indexOf('&signature=')).toBeGreaterThan(url.indexOf('externalCustomerId'))
    expect(redactUrl(url).endsWith('signature=<redacted>')).toBe(true)
    expect(redactUrl(url)).not.toContain(encodeURIComponent(sig!))
  })

  it('signQuery is the raw base64 HMAC (the SDK encodes it), and leaves out null values', () => {
    expect(signQuery('sk_test_DUMMY', '?a=1')).toBe(createHmac('sha256', 'sk_test_DUMMY').update('?a=1').digest('base64'))
    const url = signedWidgetUrl(KEYS, 'sell', { baseCurrencyCode: 'rlusd_xrp', refundWalletAddress: undefined })
    expect(url.startsWith('https://sell-sandbox.moonpay.com/?apiKey=pk_test_DUMMY&baseCurrencyCode=rlusd_xrp&signature=')).toBe(true)
  })
})

describe('IP hash (allowedIpAddress)', () => {
  it('canonicalises IPv4, ports, brackets, v4-mapped and IPv6 (RFC 5952 compression)', () => {
    expect(canonicalIp(' 178.197.176.169 ')).toBe('178.197.176.169')
    expect(canonicalIp('010.001.002.003')).toBe('10.1.2.3')
    expect(canonicalIp('178.197.176.169:443')).toBe('178.197.176.169')
    expect(canonicalIp('::ffff:178.197.176.169')).toBe('178.197.176.169')
    expect(canonicalIp('2001:0DB8:0000:0000:0000:0000:0000:0001')).toBe('2001:db8::1')
    expect(canonicalIp('[2001:db8::1]:8080')).toBe('2001:db8::1')
  })

  it('is base64 HMAC-SHA256(secret, canonical IP)', () => {
    expect(ipHash('sk_test_DUMMY', '178.197.176.169:1')).toBe(createHmac('sha256', 'sk_test_DUMMY').update('178.197.176.169').digest('base64'))
  })
})

describe('MoonPay API client', () => {
  const fakeFetch = (routes: Record<string, { status: number; body: unknown }>, seen: string[] = []) =>
    (async (input: string | URL | Request) => {
      const u = new URL(String(input))
      seen.push(u.pathname + u.search)
      const r = routes[u.pathname] ?? { status: 404, body: { message: 'not found' } }
      return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status })
    }) as typeof fetch

  it('passes the publishable key as ?apiKey= (Api-Key header is refused) and never the secret', async () => {
    const seen: string[] = []
    const api = createMoonPayApi({ publishableKey: 'pk_test_DUMMY', fetch: fakeFetch({ '/v3/ip_address': { status: 200, body: { alpha2: 'CH', ipAddress: '178.197.176.169' } } }, seen) })
    expect(await api.ipCountry('178.197.176.169')).toEqual({ status: 200, body: { alpha2: 'CH', ipAddress: '178.197.176.169' } })
    await api.ipCountry(undefined)
    expect(seen).toEqual(['/v3/ip_address?ipAddress=178.197.176.169&apiKey=pk_test_DUMMY', '/v3/ip_address?apiKey=pk_test_DUMMY'])
  })

  it('looks up buy transactions by id and by our external id', async () => {
    const seen: string[] = []
    const api = createMoonPayApi({
      publishableKey: 'pk_test_DUMMY',
      fetch: fakeFetch({ '/v1/transactions/a%20b': { status: 200, body: { id: 'a b' } }, '/v1/transactions/ext/ramp_1': { status: 200, body: [{ id: 'x' }] } }, seen),
    })
    expect((await api.getBuyTransaction('a b')).body).toEqual({ id: 'a b' })
    expect((await api.buyTransactionsByExternalId('ramp_1')).body).toEqual([{ id: 'x' }])
    expect(seen).toEqual(['/v1/transactions/a%20b?apiKey=pk_test_DUMMY', '/v1/transactions/ext/ramp_1?apiKey=pk_test_DUMMY'])
  })

  it('caches the full currency list (GET /v3/currencies/<code> is a 404), and retries after a failure', async () => {
    let calls = 0
    let fail = true
    const api = createMoonPayApi({
      publishableKey: 'pk',
      fetch: (async () => {
        calls++
        if (fail) return new Response('down', { status: 503 })
        return new Response(JSON.stringify([{ code: 'xrp' }, { code: 'rlusd_xrp', isSuspended: false }]), { status: 200 })
      }) as typeof fetch,
    })
    await expect(api.currency('rlusd_xrp')).rejects.toThrow(/currencies 503/)
    fail = false
    expect(await api.currency('rlusd_xrp')).toEqual({ code: 'rlusd_xrp', isSuspended: false })
    expect(await api.currency('xrp')).toEqual({ code: 'xrp' })
    expect(await api.currency('btc')).toBeUndefined()
    expect(calls).toBe(2)
  })

  it('returns a non-JSON body as text', async () => {
    const api = createMoonPayApi({ publishableKey: 'pk', fetch: (async () => new Response('Cannot GET', { status: 404 })) as typeof fetch })
    expect(await api.getBuyTransaction('x')).toEqual({ status: 404, body: 'Cannot GET' })
  })
})
