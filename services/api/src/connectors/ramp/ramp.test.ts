// The ramp connector over HTTP, with MoonPay and XRPL Testnet behind fakes: session, URL signing, the signed webhook,
// ledger confirmation before crediting, SPEC §2.7 (mint into the pool, payout), idempotency, the tier-0 cap, the watcher.
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { Activity } from '@zecca/contracts'
import { makeHarness } from '../../testing/harness'
import { fakeKeyStore } from '../../testing/fakes'
import { ipHash, signQuery, type MoonPayApi, type MoonPayCurrency } from './moonpay'
import { RLUSD_HEX, RLUSD_TESTNET_ISSUER } from './delivery'
import { rampCredits, rampSessions } from './store'
import type { TestnetReader } from './testnet'

const PK = 'pk_test_DUMMY'
const SK = 'sk_test_DUMMY'
const WK = 'wk_test_DUMMY'
const BROWSER_IP = '178.197.176.169'
const H1 = 'A'.repeat(63) + '1'
const H2 = 'B'.repeat(63) + '2'

function fakeMoonPay() {
  const byExt = new Map<string, any[]>()
  const ipCalls: (string | undefined)[] = []
  let currencies: MoonPayCurrency[] = [{ code: 'xrp' }, { code: 'rlusd_xrp', isSuspended: false, notAllowedCountries: ['IT', 'FR'] }]
  let country = 'CH'
  const api: MoonPayApi & { byExt: typeof byExt; ipCalls: typeof ipCalls; setCurrencies(c: MoonPayCurrency[]): void; setCountry(c: string): void } = {
    byExt,
    ipCalls,
    setCurrencies: (c) => (currencies = c),
    setCountry: (c) => (country = c),
    async ipCountry(ip) {
      ipCalls.push(ip)
      return { status: 200, body: { alpha2: country, ipAddress: ip ?? BROWSER_IP, isBuyAllowed: true } }
    },
    async getBuyTransaction(id) {
      const tx = [...byExt.values()].flat().find((t) => t.id === id)
      return tx ? { status: 200, body: tx } : { status: 404, body: { message: 'Transaction not found' } }
    },
    async buyTransactionsByExternalId(id) {
      const l = byExt.get(id)
      return l ? { status: 200, body: l } : { status: 404, body: { message: 'Transaction not found' } }
    },
    async currency(code) {
      return currencies.find((c) => c.code === code)
    },
  }
  return api
}

function fakeTestnet() {
  const txs = new Map<string, any>()
  const watchers: { address: string; cb: (h: string) => void }[] = []
  const reader: TestnetReader & { txs: typeof txs; watchers: typeof watchers; emit(hash: string): void } = {
    txs,
    watchers,
    async tx(hash) {
      return txs.get(hash.toUpperCase()) ?? null
    },
    watch(address, cb) {
      watchers.push({ address, cb })
      return () => watchers.splice(watchers.findIndex((w) => w.cb === cb), 1)
    },
    emit(hash) {
      for (const w of watchers) w.cb(hash)
    },
    async close() {},
  }
  return reader
}

const rlusdDelivery = (hash: string, to: string, o: { value?: string; issuer?: string; result?: string; validated?: boolean } = {}) => ({
  hash,
  validated: o.validated ?? true,
  tx_json: { TransactionType: 'Payment', Account: 'rUZTCFB6zPyeEmDhrAVqVbBaLPWrzjKCQz', Destination: to },
  meta: { TransactionResult: o.result ?? 'tesSUCCESS', delivered_amount: { currency: RLUSD_HEX, issuer: o.issuer ?? RLUSD_TESTNET_ISSUER, value: o.value ?? '0.2852' } },
})

function world(o: { env?: Record<string, string>; treasury?: boolean } = {}) {
  const keystore = fakeKeyStore()
  const treasury = xrpl.Wallet.generate('ed25519' as never)
  if (o.treasury !== false) keystore.setWallet('testnetTreasury', { address: treasury.classicAddress, seed: treasury.seed!, algorithm: 'ed25519' })
  const moonpay = fakeMoonPay()
  const testnet = fakeTestnet()
  const h = makeHarness({
    keystore,
    env: { FEATURE_RAMP: '1', MOONPAY_PUBLISHABLE_KEY: PK, MOONPAY_SECRET_KEY: SK, MOONPAY_WEBHOOK_KEY: WK, RAMP_SANDBOX_SCALE: '100', ...o.env },
    extra: { ramp: { moonpay, testnet, pollMs: 0 } },
  })
  const signed = (body: unknown, t = Math.floor(h.clock.now / 1000)) => {
    const raw = JSON.stringify(body)
    return { raw, header: `t=${t},s=${createHmac('sha256', WK).update(`${t}.${raw}`).digest('hex')}` }
  }
  const webhook = (body: unknown, header?: string) => {
    const s = signed(body)
    return h.call('POST', '/v1/webhooks/moonpay', { body: s.raw, headers: { 'moonpay-signature-v2': header ?? s.header } })
  }
  const session = async (token: string, body: Record<string, unknown> = { direction: 'buy', fiatAmount: 25 }, headers: Record<string, string> = { 'x-forwarded-for': BROWSER_IP }) =>
    h.json('POST', '/v1/ramp/session', { token, body, ...({ headers } as object) })
  return { h, moonpay, testnet, treasury: treasury.classicAddress, webhook, signed, session }
}

/** A completed MoonPay buy for one of our sessions, as the webhook's `data` and GET /v1/transactions/ext/:id carry it. */
const buy = (externalId: string, walletAddress: string, o: Record<string, unknown> = {}) => ({
  id: `mp-${externalId}`,
  status: 'completed',
  externalTransactionId: externalId,
  walletAddress,
  cryptoTransactionId: H1,
  baseCurrencyAmount: 21.7,
  quoteCurrencyAmount: 28.52,
  usdRate: 1,
  currency: { code: 'rlusd_xrp' },
  ...o,
})

describe('POST /v1/ramp/session', () => {
  it('signs a sandbox buy URL for the Testnet treasury, bound to the user by a new external id and to the browser IP', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const r = await w.session(ana.token, { direction: 'buy', fiatAmount: 50 })
    expect(r.status).toBe(200)
    expect(r.body.sandbox).toBe(true)
    const u = new URL(r.body.widgetUrl)
    expect(u.host).toBe('buy-sandbox.moonpay.com')
    const q = u.searchParams
    expect(q.get('apiKey')).toBe(PK)
    expect(q.get('walletAddress')).toBe(w.treasury)
    expect(q.get('currencyCode')).toBe('rlusd_xrp')
    expect(q.get('baseCurrencyCode')).toBe('usd')
    expect(q.get('baseCurrencyAmount')).toBe('50')
    expect(q.get('externalTransactionId')).toBe(r.body.externalId)
    expect(q.get('allowedIpAddress')).toBe(ipHash(SK, BROWSER_IP))
    const sig = q.get('signature')!
    expect(sig).toBe(signQuery(SK, r.body.widgetUrl.split('&signature=')[0].slice(r.body.widgetUrl.indexOf('?'))))
    expect(r.body.params).toMatchObject({ apiKey: PK, walletAddress: w.treasury, externalTransactionId: r.body.externalId, baseCurrencyAmount: '50' })
    expect(w.moonpay.ipCalls).toEqual([BROWSER_IP])
    expect(rampSessions.byExternalId(w.h.app.core.db, r.body.externalId)).toMatchObject({ userId: ana.user.id, walletAddress: w.treasury, currencyCode: 'rlusd_xrp' })
  })

  it('on localhost lets MoonPay see the public IP itself (no ipAddress), and says sandbox only when the scale is not 1', async () => {
    const w = world({ env: { RAMP_SANDBOX_SCALE: '1' } })
    const ana = await w.h.signUp('ana')
    const r = await w.session(ana.token, { direction: 'buy' }, {})
    expect(r.status).toBe(200)
    expect(r.body.sandbox).toBe(false)
    expect(w.moonpay.ipCalls).toEqual([undefined])
    await w.session(ana.token, { direction: 'buy' }, { 'x-forwarded-for': '192.168.1.20, 10.0.0.1' })
    expect(w.moonpay.ipCalls[1]).toBeUndefined()
  })

  it('falls back to XRP when RLUSD is not listed, suspended, or not allowed in the country MoonPay sees', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const code = async () => new URL((await w.session(ana.token)).body.widgetUrl).searchParams.get('currencyCode')
    expect(await code()).toBe('rlusd_xrp')
    w.moonpay.setCountry('IT')
    expect(await code()).toBe('xrp')
    w.moonpay.setCountry('CH')
    w.moonpay.setCurrencies([{ code: 'xrp' }, { code: 'rlusd_xrp', isSuspended: true }])
    expect(await code()).toBe('xrp')
    w.moonpay.setCurrencies([{ code: 'xrp' }])
    expect(await code()).toBe('xrp')
  })

  it('503 "Top-up is not available right now." without a Testnet treasury or MoonPay keys; sell is not built (feature_off)', async () => {
    const noTreasury = world({ treasury: false })
    const ana = await noTreasury.h.signUp('ana')
    const r = await noTreasury.session(ana.token)
    expect(r.status).toBe(503)
    expect(r.body.error).toEqual({ code: 'upstream_error', message: 'Top-up is not available right now.' })
    const noKeys = world({ env: { MOONPAY_SECRET_KEY: '' } })
    const bo = await noKeys.h.signUp('bob')
    expect((await noKeys.session(bo.token)).status).toBe(503)
    const w = world()
    const cy = await w.h.signUp('cyd')
    expect((await w.session(cy.token, { direction: 'sell', fiatAmount: 25 })).body.error.code).toBe('feature_off')
  })

  it('refuses up front a purchase that would take a tier-0 balance over the cap (the limit sheet), before any payment', async () => {
    const w = world()
    const ana = await w.h.signUp('ana') // $50 welcome credit, cap $150
    const r = await w.session(ana.token, { direction: 'buy', fiatAmount: 101 })
    expect(r.status).toBe(403)
    expect(r.body.error).toMatchObject({ code: 'limit_reached', details: { limit: 'balance', capMinor: 15000, usedMinor: 5000 } })
    expect((await w.session(ana.token, { direction: 'buy', fiatAmount: 100 })).status).toBe(200)
  })

  it('is 404 feature_off when the ramp is off', async () => {
    const w = world({ env: { FEATURE_RAMP: '0' } })
    const ana = await w.h.signUp('ana')
    expect((await w.session(ana.token)).body.error.code).toBe('feature_off')
  })
})

describe('POST /v1/ramp/sign', () => {
  async function sdkUrl(w: ReturnType<typeof world>, token: string, edit: (q: URLSearchParams) => void = () => {}) {
    const s = await w.session(token)
    const u = new URL('https://buy-sandbox.moonpay.com/')
    for (const [k, v] of Object.entries(s.body.params as Record<string, string>)) u.searchParams.set(k, v)
    edit(u.searchParams)
    return u
  }

  it("signs the web SDK's URL (raw base64 over ?query without signature) for our key, treasury, issued IP hash and the caller's session", async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const u = await sdkUrl(w, ana.token, (q) => q.set('signature', 'stale'))
    const r = await w.h.json('POST', '/v1/ramp/sign', { token: ana.token, body: { url: u.toString() } })
    expect(r.status).toBe(200)
    u.searchParams.delete('signature')
    expect(r.body.signature).toBe(signQuery(SK, u.search))
  })

  it('refuses another host, another key, another wallet, a refund wallet, a multi-address list, an IP hash or session it did not issue, or another currency', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const bo = await w.h.signUp('bob')
    const boSession = await w.session(bo.token)
    const bad: [string, (u: URL) => void][] = [
      ['host', (u) => (u.host = 'buy.evil.example')],
      ['sell host', (u) => (u.host = 'sell-sandbox.moonpay.com')],
      ['apiKey', (u) => u.searchParams.set('apiKey', 'pk_test_OTHER')],
      ['wallet', (u) => u.searchParams.set('walletAddress', 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS')],
      ['refund', (u) => u.searchParams.set('refundWalletAddress', 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS')],
      ['multi', (u) => u.searchParams.set('walletAddresses', '{}')],
      ['ip', (u) => u.searchParams.set('allowedIpAddress', ipHash(SK, '1.2.3.4'))],
      ['no session', (u) => u.searchParams.delete('externalTransactionId')],
      ['other user', (u) => u.searchParams.set('externalTransactionId', boSession.body.externalId)],
      ['currency', (u) => u.searchParams.set('currencyCode', 'btc')],
    ]
    for (const [why, edit] of bad) {
      const u = await sdkUrl(w, ana.token)
      edit(u)
      const r = await w.h.json('POST', '/v1/ramp/sign', { token: ana.token, body: { url: u.toString() } })
      expect(r.status, why).toBe(400)
      expect(r.body.error.message, why).toBe('This top-up link is not valid. Start again.')
    }
  })
})

describe('POST /v1/webhooks/moonpay', () => {
  it('401 on a missing, wrong or stale signature, and when no webhook key is configured (never weakened)', async () => {
    const w = world()
    const body = { type: 'transaction_updated', data: { id: 'x', status: 'completed' } }
    expect((await w.webhook(body, 'garbage')).status).toBe(401)
    expect((await w.h.call('POST', '/v1/webhooks/moonpay', { body: JSON.stringify(body) })).status).toBe(401)
    const stale = w.signed(body, Math.floor(w.h.clock.now / 1000) - 3600)
    expect((await w.h.call('POST', '/v1/webhooks/moonpay', { body: stale.raw, headers: { 'moonpay-signature-v2': stale.header } })).status).toBe(401)
    const tampered = w.signed(body)
    expect((await w.h.call('POST', '/v1/webhooks/moonpay', { body: tampered.raw + ' ', headers: { 'moonpay-signature-v2': tampered.header } })).status).toBe(401)
    const noKey = world({ env: { MOONPAY_WEBHOOK_KEY: '' } })
    expect((await noKey.webhook(body)).status).toBe(401)
    expect((await w.webhook(body)).status).toBe(200)
  })

  it('a completed buy: confirmed on Testnet, then SPEC §2.7 (mint referenced by the delivery hash, payout), credits the delivered amount x scale', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    w.testnet.txs.set(H1, rlusdDelivery(H1, w.treasury))
    const r = await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury), externalCustomerId: ana.user.id })
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true })
    await w.h.settle()
    expect(w.h.pool.mints).toEqual([{ amountMinor: 2852, reference: H1 }])
    expect(w.h.pool.payouts).toEqual([expect.objectContaining({ to: ana.user.address, amountMinor: 2852 })])
    expect((await w.h.json('GET', '/v1/balance', { token: ana.token })).body).toMatchObject({ availableMinor: 5000 + 2852, pendingMinor: 0 })
    const act = Activity.parse((await w.h.json('GET', '/v1/activity', { token: ana.token })).body.items[0])
    expect(act).toMatchObject({ kind: 'topup', direction: 'in', amountMinor: 2852, status: 'done', note: 'Sandbox', ledger: { network: 'testnet', depositTxHash: H1 } })
    expect(rampCredits.byMoonPayId(w.h.app.core.db, `mp-${s.body.externalId}`)).toMatchObject({ status: 'credited', amountMinor: 2852, deliveryHash: H1, source: 'webhook' })
    expect(rampCredits.byMoonPayId(w.h.app.core.db, `mp-${s.body.externalId}`)?.mintHash).toMatch(/^[0-9A-F]{64}$/)
  })

  it('is idempotent per MoonPay transaction and per delivery hash (replays, a second id on the same hash, the watcher afterwards)', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    const s2 = await w.session(ana.token)
    w.testnet.txs.set(H1, rlusdDelivery(H1, w.treasury))
    const tx = buy(s.body.externalId, w.treasury)
    await Promise.all([w.webhook({ type: 'transaction_updated', data: tx }), w.webhook({ type: 'transaction_updated', data: tx })])
    await w.h.settle()
    await w.webhook({ type: 'transaction_updated', data: tx })
    await w.webhook({ type: 'transaction_updated', data: buy(s2.body.externalId, w.treasury, { id: 'mp-other' }) })
    w.moonpay.byExt.set(s.body.externalId, [tx])
    w.testnet.emit(H1)
    await w.h.settle()
    expect(w.h.pool.mints).toHaveLength(1)
    expect((await w.h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(7852)
  })

  it('waits while the delivery is not validated or MoonPay has no delivery hash yet; ignores failed buys and other wallets or sessions', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury, { status: 'pending', cryptoTransactionId: null }) })
    w.testnet.txs.set(H1, rlusdDelivery(H1, w.treasury, { validated: false }))
    await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury) })
    await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury, { id: 'mp-f', status: 'failed', cryptoTransactionId: H2 }) })
    await w.webhook({ type: 'transaction_updated', data: buy('ramp_not_ours', w.treasury, { cryptoTransactionId: H2 }) })
    await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS', { id: 'mp-w', cryptoTransactionId: H2 }) })
    await w.h.settle()
    expect(w.h.pool.mints).toEqual([])
    expect(rampCredits.byHash(w.h.app.core.db, H1)).toBeUndefined()
    // Validated later: the next webhook (or the watcher) credits it once.
    w.testnet.txs.set(H1, rlusdDelivery(H1, w.treasury))
    await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury) })
    await w.h.settle()
    expect(w.h.pool.mints).toEqual([{ amountMinor: 2852, reference: H1 }])
  })

  it('refuses for good a delivery with the wrong destination, issuer or result: recorded, nothing credited', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const cases = [
      rlusdDelivery(H1, 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS'),
      rlusdDelivery(H1, w.treasury, { issuer: 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De' }),
      rlusdDelivery(H1, w.treasury, { result: 'tecPATH_PARTIAL' }),
    ]
    for (const [k, delivery] of cases.entries()) {
      const s = await w.session(ana.token)
      const hash = String(k).repeat(64)
      w.testnet.txs.set(hash, { ...delivery, hash })
      await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury, { cryptoTransactionId: hash }) })
      await w.h.settle()
      expect(rampCredits.byHash(w.h.app.core.db, hash)?.status).toBe('rejected')
    }
    expect(w.h.pool.mints).toEqual([])
    expect((await w.h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(5000)
  })

  it('credits an XRP delivery (MoonPay fallback) at the price MoonPay charged', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    w.testnet.txs.set(H1, { ...rlusdDelivery(H1, w.treasury), meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '100000' } })
    // $26.30 net bought 10 XRP; the sandbox delivered 0.1 XRP; scale 100 -> $26.30.
    await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury, { currency: { code: 'xrp' }, baseCurrencyAmount: 26.3, quoteCurrencyAmount: 10 }) })
    await w.h.settle()
    expect(w.h.pool.mints).toEqual([{ amountMinor: 2630, reference: H1 }])
  })

  it('over the tier-0 balance cap: refuses to credit, records it, logs it, and shows the user a failed top-up with the reason', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    w.testnet.txs.set(H1, rlusdDelivery(H1, w.treasury, { value: '1.2' })) // $120 with the scale, $50 already held, cap $150
    await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury) })
    await w.h.settle()
    expect(w.h.pool.mints).toEqual([])
    expect(rampCredits.byHash(w.h.app.core.db, H1)).toMatchObject({ status: 'refused_limit', amountMinor: 12000 })
    expect((await w.h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(5000)
    const act = (await w.h.json('GET', '/v1/activity', { token: ana.token })).body.items[0]
    expect(act).toMatchObject({ kind: 'topup', status: 'failed', amountMinor: 12000, ledger: { network: 'testnet', depositTxHash: H1 } })
    const failed = w.h.app.core.bus.history().find((x) => x.event.type === 'intent.updated' && x.event.data.status === 'failed')
    expect(failed?.event.type === 'intent.updated' && failed.event.data.failure?.message).toMatch(/unverified accounts can hold up to \$150\.00/)
  })

  it('a failed mint fails the top-up visibly and keeps the record for a manual retry', async () => {
    const w = world()
    w.h.pool.mintIn = async () => {
      throw new Error('issuer down')
    }
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    w.testnet.txs.set(H1, rlusdDelivery(H1, w.treasury))
    await w.webhook({ type: 'transaction_updated', data: buy(s.body.externalId, w.treasury) })
    await w.h.settle()
    expect(rampCredits.byHash(w.h.app.core.db, H1)?.status).toBe('mint_failed')
    expect((await w.h.json('GET', '/v1/activity', { token: ana.token })).body.items[0]).toMatchObject({ kind: 'topup', status: 'failed' })
    expect((await w.h.json('GET', '/v1/balance', { token: ana.token })).body.availableMinor).toBe(5000)
  })
})

describe('Testnet watcher (second trigger when the webhook is late)', () => {
  it('watches the treasury; a delivery there makes it look up our open sessions at MoonPay and credit by cryptoTransactionId', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    expect(w.testnet.watchers.map((x) => x.address)).toEqual([w.treasury])
    w.moonpay.byExt.set(s.body.externalId, [buy(s.body.externalId, w.treasury, { status: 'pending' })])
    w.testnet.txs.set(H1, rlusdDelivery(H1, w.treasury))
    w.testnet.emit(H1)
    await w.h.settle()
    expect(w.h.pool.mints).toEqual([{ amountMinor: 2852, reference: H1 }])
    expect(rampCredits.byHash(w.h.app.core.db, H1)).toMatchObject({ status: 'credited', source: 'watcher' })
    // The session is done: later deliveries do not query MoonPay for it again.
    expect(rampSessions.open(w.h.app.core.db, '2000-01-01T00:00:00.000Z', 10).map((x) => x.externalId)).not.toContain(s.body.externalId)
  })
})
