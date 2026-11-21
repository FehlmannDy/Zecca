// Withdrawal through MoonPay sell (SPEC §4.5), over HTTP with MoonPay, Testnet and the treasury's payments behind fakes:
// the sell session, URL signing, the deposit re-read from MoonPay, the cents maths, one treasury payment per intent, the
// refund when it fails, MoonPay's status from signed webhooks and the poll, and the flag.
import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { getBalance } from '../../books'
import { intents } from '../../intents/repo'
import { makeHarness } from '../../testing/harness'
import { fakeKeyStore } from '../../testing/fakes'
import { ipHash, signQuery, type MoonPayApi } from './moonpay'
import { RLUSD_HEX, RLUSD_TESTNET_ISSUER } from './delivery'
import { rampSessions } from './store'
import { withdrawals } from './sell-store'
import type { TestnetReader } from './testnet'
import type { TreasuryPayer } from './treasury'

const PK = 'pk_test_DUMMY'
const SK = 'sk_test_DUMMY'
const WK = 'wk_test_DUMMY'
const BROWSER_IP = '178.197.176.169'
const MP_DEPOSIT = 'rUZTCFB6zPyeEmDhrAVqVbBaLPWrzjKCQz'
const OTHER = 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS'

function fakeMoonPay() {
  const sells = new Map<string, any>()
  let country = 'CH'
  let sellAllowed = true
  let down = false
  const api: MoonPayApi & { sells: typeof sells; setCountry(c: string): void; setSellAllowed(b: boolean): void; setDown(b: boolean): void } = {
    sells,
    setCountry: (c) => (country = c),
    setSellAllowed: (b) => (sellAllowed = b),
    setDown: (b) => (down = b),
    async ipCountry(ip) {
      return { status: 200, body: { alpha2: country, ipAddress: ip ?? BROWSER_IP, isBuyAllowed: true, isSellAllowed: sellAllowed } }
    },
    async getBuyTransaction() {
      return { status: 404, body: {} }
    },
    async buyTransactionsByExternalId() {
      return { status: 404, body: {} }
    },
    async getSellTransaction(id) {
      if (down) throw new Error('fetch failed')
      const t = sells.get(id)
      return t ? { status: 200, body: structuredClone(t) } : { status: 404, body: { message: 'Transaction not found' } }
    },
    async currency(code) {
      return [{ code: 'xrp' }, { code: 'rlusd_xrp', isSuspended: false, notAllowedCountries: ['IT'] }].find((c) => c.code === code)
    },
  }
  return api
}

function fakeTestnet() {
  const watchers: ((h: string) => void)[] = []
  const reader: TestnetReader & { emit(hash: string): void } = {
    tx: async () => null,
    watch: (_address, cb) => {
      watchers.push(cb)
      return () => {}
    },
    emit: (hash) => watchers.forEach((cb) => cb(hash)),
    close: async () => {},
  }
  return reader
}

type Mode = 'ok' | 'tec' | 'unknown' | 'throwBeforeSign' | 'throwAfterSign'
function fakeTreasury() {
  const ledger = new Map<string, { validated: boolean; engineResult: string }>()
  const payments: { destination: string; tag?: number; amount: unknown; hash: string }[] = []
  const modes: Mode[] = []
  let can = true
  let index = 100
  let n = 0
  const t: TreasuryPayer & { ledger: typeof ledger; payments: typeof payments; modes: Mode[]; setCan(b: boolean): void; setIndex(i: number): void } = {
    ledger,
    payments,
    modes,
    setCan: (b) => (can = b),
    setIndex: (i) => (index = i),
    async canPay() {
      return can
    },
    async pay(p, onSigned) {
      const mode = modes.shift() ?? 'ok'
      if (mode === 'throwBeforeSign') throw new Error('autofill: socket closed')
      const hash = createHash('sha256').update(`pay-${++n}`).digest('hex').toUpperCase()
      onSigned({ hash, lastLedgerSequence: index + 20 })
      payments.push({ ...p, hash })
      await new Promise((r) => setTimeout(r, 1))
      if (mode === 'throwAfterSign') throw new Error('socket dropped')
      if (mode === 'unknown') return { validated: false, engineResult: 'SUBMIT_ERROR', hash }
      if (mode === 'tec') {
        ledger.set(hash, { validated: true, engineResult: 'tecPATH_DRY' })
        return { validated: false, engineResult: 'tecPATH_DRY', hash, ledgerIndex: index }
      }
      ledger.set(hash, { validated: true, engineResult: 'tesSUCCESS' })
      return { validated: true, engineResult: 'tesSUCCESS', hash, ledgerIndex: index }
    },
    async txResult(hash) {
      return ledger.get(hash) ?? null
    },
    async ledgerIndex() {
      return index
    },
  }
  return t
}

function world(o: { env?: Record<string, string> } = {}) {
  const keystore = fakeKeyStore()
  const tw = xrpl.Wallet.generate('ed25519' as never)
  keystore.setWallet('testnetTreasury', { address: tw.classicAddress, seed: tw.seed!, algorithm: 'ed25519' })
  const moonpay = fakeMoonPay()
  const treasury = fakeTreasury()
  const testnet = fakeTestnet()
  const h = makeHarness({
    keystore,
    env: { FEATURE_RAMP: '1', FEATURE_WITHDRAW: '1', MOONPAY_PUBLISHABLE_KEY: PK, MOONPAY_SECRET_KEY: SK, MOONPAY_WEBHOOK_KEY: WK, ...o.env },
    extra: { ramp: { moonpay, testnet, treasury, pollMs: 0 } },
  })
  const core = h.app.core
  const session = (token: string, body: Record<string, unknown> = { direction: 'sell', fiatAmount: 25 }) =>
    h.json('POST', '/v1/ramp/session', { token, body, ...({ headers: { 'x-forwarded-for': BROWSER_IP } } as object) })
  const webhook = (body: unknown) => {
    const raw = JSON.stringify(body)
    const t = Math.floor(h.clock.now / 1000)
    return h.call('POST', '/v1/webhooks/moonpay', { body: raw, headers: { 'moonpay-signature-v2': `t=${t},s=${createHmac('sha256', WK).update(`${t}.${raw}`).digest('hex')}` } })
  }
  /** MoonPay's sale for a session, as GET /v3/sell_transactions/:id returns it. */
  const sale = (externalId: string, o: Record<string, unknown> = {}) => {
    const tx = {
      id: `mps-${externalId}`,
      status: 'waitingForDeposit',
      externalTransactionId: externalId,
      baseCurrencyAmount: 19.65,
      quoteCurrencyAmount: 18.4,
      usdRate: 1,
      baseCurrency: { code: 'rlusd_xrp' },
      quoteCurrency: { code: 'usd' },
      refundWalletAddress: tw.classicAddress,
      ...o,
    }
    moonpay.sells.set(tx.id, tx)
    return tx
  }
  const deposit = (token: string, body: Record<string, unknown>) => h.json('POST', '/v1/ramp/sell/deposit', { token, body })
  const status = (token: string, id: string) => h.json('GET', `/v1/ramp/sell/${id}`, { token })
  /** Session -> MoonPay sale -> deposit route -> approve (sign + submit) -> the pool confirms. */
  async function withdraw(u: { token: string; signer: any }, saleOver: Record<string, unknown> = {}, widget: Record<string, unknown> = { depositWalletAddress: MP_DEPOSIT, depositWalletAddressTag: '424242' }) {
    const s = await session(u.token)
    expect(s.status).toBe(200)
    const tx = sale(s.body.externalId, saleOver)
    const d = await deposit(u.token, { externalId: s.body.externalId, transactionId: tx.id, ...widget })
    expect(d.status, JSON.stringify(d.body)).toBe(200)
    const sub = await h.submit(u, d.body.prepared)
    expect(sub.body.status).toBe('validated')
    await h.settle()
    return { s, tx, d, id: d.body.intent.id as string }
  }
  /** One pass of the ramp's watcher (a timer in production; a treasury event here). */
  const scan = async () => {
    testnet.emit('A'.repeat(64))
    await h.settle()
  }
  return { h, core, moonpay, treasury, scan, treasuryAddress: tw.classicAddress, session, webhook, sale, deposit, status, withdraw }
}

describe('POST /v1/ramp/session { direction: sell }', () => {
  it('signs a sandbox sell widget: our refund wallet (the Testnet treasury), dollars, card payout, bound to the user and the browser IP', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const r = await w.session(ana.token)
    expect(r.status).toBe(200)
    expect(r.body.sandbox).toBe(true)
    const u = new URL(r.body.widgetUrl)
    expect(u.host).toBe('sell-sandbox.moonpay.com')
    const q = u.searchParams
    expect(Object.fromEntries([...q].filter(([k]) => k !== 'signature'))).toEqual({
      apiKey: PK,
      baseCurrencyCode: 'rlusd_xrp',
      quoteCurrencyCode: 'usd',
      quoteCurrencyAmount: '25',
      refundWalletAddress: w.treasuryAddress,
      paymentMethod: 'credit_debit_card',
      externalCustomerId: ana.user.id,
      externalTransactionId: r.body.externalId,
      allowedIpAddress: ipHash(SK, BROWSER_IP),
    })
    expect(q.get('signature')).toBe(signQuery(SK, r.body.widgetUrl.split('&signature=')[0].slice(r.body.widgetUrl.indexOf('?'))))
    expect(rampSessions.byExternalId(w.core.db, r.body.externalId)).toMatchObject({ userId: ana.user.id, direction: 'sell', currencyCode: 'rlusd_xrp', walletAddress: w.treasuryAddress, fiatAmount: '25' })
    w.moonpay.setCountry('IT')
    expect(new URL((await w.session(ana.token)).body.widgetUrl).searchParams.get('baseCurrencyCode')).toBe('xrp')
  })

  it('sells XRP where RLUSD is allowed but the treasury does not hold the RLUSD to pay MoonPay (no dead end after the approval)', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const asked: unknown[] = []
    const canPay = w.treasury.canPay
    w.treasury.canPay = async (a) => (asked.push(a), typeof a === 'string')
    expect(new URL((await w.session(ana.token)).body.widgetUrl).searchParams.get('baseCurrencyCode')).toBe('xrp')
    expect(asked).toEqual([{ currency: RLUSD_HEX, issuer: RLUSD_TESTNET_ISSUER, value: '25' }])
    w.treasury.canPay = canPay
    expect(new URL((await w.session(ana.token)).body.widgetUrl).searchParams.get('baseCurrencyCode')).toBe('rlusd_xrp')
  })

  it('refuses: the flag off, under $20 or not whole dollars, not dollars, over the tier-0 per-payment cap or the balance, a region MoonPay refuses', async () => {
    const off = world({ env: { FEATURE_WITHDRAW: '0' } })
    const bo = await off.h.signUp('bob')
    expect((await off.session(bo.token)).body.error.code).toBe('feature_off')
    const w = world()
    const ana = await w.h.signUp('ana') // $50 welcome credit, tier 0 cap $50 per payment
    for (const fiatAmount of [19, 20.5]) expect((await w.session(ana.token, { direction: 'sell', fiatAmount })).body.error).toEqual({ code: 'bad_request', message: 'Withdrawals start at $20.00.' })
    expect((await w.session(ana.token, { direction: 'sell', fiatAmount: 25, fiatCurrency: 'eur' })).body.error.message).toBe('Withdrawals are in dollars.')
    expect((await w.session(ana.token, { direction: 'sell', fiatAmount: 60 })).body.error).toMatchObject({ code: 'limit_reached', details: { limit: 'per_payment' } })
    w.core.db.prepare('UPDATE users SET tier = 1 WHERE id = ?').run(ana.user.id)
    expect((await w.session(ana.token, { direction: 'sell', fiatAmount: 60 })).body.error.code).toBe('insufficient_funds')
    w.moonpay.setSellAllowed(false)
    expect((await w.session(ana.token)).body.error.message).toBe("Withdrawals aren't available in your country yet.")
  })
})

describe('POST /v1/ramp/sign for the sell widget', () => {
  async function sdkUrl(w: ReturnType<typeof world>, token: string, edit: (q: URLSearchParams) => void = () => {}) {
    const s = await w.session(token)
    const u = new URL('https://sell-sandbox.moonpay.com/')
    for (const [k, v] of Object.entries(s.body.params as Record<string, string>)) u.searchParams.set(k, v)
    u.searchParams.set('mpSdk', 'eyJ2ZXJzaW9uIjoiMS4wIn0') // the web SDK adds its own marker (seen live, 2026-11-21)
    edit(u.searchParams)
    return u
  }
  const sign = (w: ReturnType<typeof world>, token: string, u: URL) => w.h.json('POST', '/v1/ramp/sign', { token, body: { url: u.toString() } })

  it("signs the SDK's sell URL for the caller's own session", async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const u = await sdkUrl(w, ana.token)
    const r = await sign(w, ana.token, u)
    expect(r.status).toBe(200)
    expect(r.body.signature).toBe(signQuery(SK, u.search))
  })

  it('refuses another refund wallet, a receive wallet, a crypto amount, another fiat amount or currency, a buy session, another user, or the flag off', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const bo = await w.h.signUp('bob')
    const boSell = await w.session(bo.token)
    const anaBuy = await w.h.json('POST', '/v1/ramp/session', { token: ana.token, body: { direction: 'buy', fiatAmount: 25 } })
    const bad: [string, (q: URLSearchParams) => void][] = [
      ['refund wallet', (q) => q.set('refundWalletAddress', OTHER)],
      ['receive wallet', (q) => q.set('walletAddress', OTHER)],
      ['refund wallets', (q) => q.set('refundWalletAddresses', '{}')],
      ['crypto amount', (q) => q.set('baseCurrencyAmount', '1000')],
      ['fiat amount', (q) => q.set('quoteCurrencyAmount', '45')],
      ['currency', (q) => q.set('baseCurrencyCode', 'btc')],
      ['ip', (q) => q.set('allowedIpAddress', ipHash(SK, '1.2.3.4'))],
      ['buy session', (q) => q.set('externalTransactionId', anaBuy.body.externalId)],
      ['other user', (q) => q.set('externalTransactionId', boSell.body.externalId)],
    ]
    for (const [why, edit] of bad) {
      const r = await sign(w, ana.token, await sdkUrl(w, ana.token, edit))
      expect(r.status, why).toBe(400)
    }
    // And a sell session is no use on the buy widget.
    const s = await w.session(ana.token)
    const buyUrl = new URL('https://buy-sandbox.moonpay.com/')
    for (const [k, v] of Object.entries({ apiKey: PK, walletAddress: w.treasuryAddress, baseCurrencyCode: 'usd', baseCurrencyAmount: '25', lockAmount: 'true', externalTransactionId: s.body.externalId, allowedIpAddress: ipHash(SK, BROWSER_IP) }))
      buyUrl.searchParams.set(k, v)
    expect((await sign(w, ana.token, buyUrl)).status).toBe(400)
    const u = await sdkUrl(w, ana.token)
    w.core.settings.features.withdraw = false
    expect((await sign(w, ana.token, u)).status).toBe(400)
  })
})

describe('POST /v1/ramp/sell/deposit (the widget asked us to deposit)', () => {
  it("prices MoonPay's own amount (not the browser's), opens a 'withdraw' intent and the user's deposit to the pool; on 'received' the treasury pays MoonPay once", async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    const tx = w.sale(s.body.externalId)
    const d = await w.deposit(ana.token, { externalId: s.body.externalId, transactionId: tx.id, depositWalletAddress: MP_DEPOSIT, depositWalletAddressTag: '424242', cryptoCurrencyAmount: '0.01' })
    expect(d.status).toBe(200)
    expect(d.body.intent).toMatchObject({ kind: 'withdraw', status: 'created', amountMinor: 1965, feeMinor: 0, fromUserId: ana.user.id })
    expect(d.body.prepared).toMatchObject({ kind: 'send', tx: { TransactionType: 'ConfidentialMPTSend', Account: ana.user.address, Destination: w.h.keystore.getWallet('pool').address } })
    expect(d.body.withdrawal).toMatchObject({ id: d.body.intent.id, status: 'approve', amountMinor: 1965, sandbox: true })
    expect(w.treasury.payments).toEqual([])

    expect((await w.h.submit(ana, d.body.prepared)).body.status).toBe('validated')
    await w.h.settle()
    expect(w.treasury.payments).toEqual([{ destination: MP_DEPOSIT, tag: 424242, amount: { currency: RLUSD_HEX, issuer: RLUSD_TESTNET_ISSUER, value: '19.65' }, hash: expect.stringMatching(/^[0-9A-F]{64}$/) }])
    expect(intents.byId(w.core, d.body.intent.id)).toMatchObject({ status: 'paid_out' })
    expect((await w.status(ana.token, d.body.intent.id)).body).toMatchObject({ status: 'sent', refunded: false })
    expect(getBalance(w.core, ana.user.id).availableMinor).toBe(5000 - 1965)
    expect(w.h.pool.payouts).toEqual([]) // nothing comes back from the pool
    const act = (await w.h.json('GET', '/v1/activity', { token: ana.token })).body.items[0]
    expect(act).toMatchObject({ kind: 'withdraw', direction: 'out', amountMinor: 1965, status: 'done' })
    // Again, from the handler, the watcher and a replayed deposit: still one payment.
    await Promise.all([w.core.receivedHandlers.get('withdraw')!(w.core, d.body.intent.id), w.core.receivedHandlers.get('withdraw')!(w.core, d.body.intent.id)])
    expect((await w.deposit(ana.token, { externalId: s.body.externalId, transactionId: tx.id })).body.error.code).toBe('conflict')
    expect(w.treasury.payments).toHaveLength(1)
  })

  it("an XRP sale is priced at MoonPay's usdRate, rounded up, and paid in drops", async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    w.moonpay.setCountry('IT')
    const { d } = await w.withdraw(ana, { baseCurrency: { code: 'xrp' }, baseCurrencyAmount: 21.77, usdRate: 2.0001 })
    expect(d.body.intent.amountMinor).toBe(4355) // 43.542177 -> 43.55
    expect(w.treasury.payments[0]).toMatchObject({ destination: MP_DEPOSIT, tag: 424242, amount: '21770000' })
  })

  it("uses MoonPay's deposit wallet (API or signed webhook) and refuses a widget address that contradicts it", async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    const tx = w.sale(s.body.externalId)
    // The signed sell_transaction_created arrives first, with the deposit wallet.
    await w.webhook({ type: 'sell_transaction_created', data: { ...tx, depositWallet: { walletAddress: MP_DEPOSIT, walletAddressTag: '77' } } })
    expect((await w.deposit(ana.token, { externalId: s.body.externalId, transactionId: tx.id, depositWalletAddress: OTHER, depositWalletAddressTag: '77' })).status).toBe(400)
    expect((await w.deposit(ana.token, { externalId: s.body.externalId, transactionId: tx.id, depositWalletAddress: MP_DEPOSIT, depositWalletAddressTag: '78' })).status).toBe(400)
    const d = await w.deposit(ana.token, { externalId: s.body.externalId, transactionId: tx.id })
    expect(d.status).toBe(200)
    expect(withdrawals.byIntent(w.core.db, d.body.intent.id)).toMatchObject({ destination: MP_DEPOSIT, destinationTag: 77, destinationSource: 'moonpay' })
  })

  it('refuses a session or sale that is not the caller’s, a sale MoonPay no longer waits for, MoonPay down, no deposit address, the treasury short, the limits', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const bo = await w.h.signUp('bob')
    const s = await w.session(ana.token)
    const tx = w.sale(s.body.externalId)
    const body = { externalId: s.body.externalId, transactionId: tx.id, depositWalletAddress: MP_DEPOSIT }
    expect((await w.deposit(bo.token, body)).body.error.message).toBe('This withdrawal is not valid. Start again.')
    expect((await w.deposit(ana.token, { ...body, transactionId: 'mps-unknown' })).status).toBe(400)
    const other = w.sale('ramp_someone_else', { id: 'mps-x' })
    expect((await w.deposit(ana.token, { ...body, transactionId: other.id })).status).toBe(400)
    expect((await w.deposit(ana.token, { ...body, depositWalletAddress: undefined })).status).toBe(400)
    w.moonpay.sells.set(tx.id, { ...tx, baseCurrency: { code: 'xrp' } })
    expect((await w.deposit(ana.token, body)).status).toBe(400)
    w.moonpay.sells.set(tx.id, { ...tx, status: 'failed' })
    expect((await w.deposit(ana.token, body)).body.error.message).toBe('MoonPay is no longer waiting for this withdrawal. Start again.')
    w.moonpay.sells.set(tx.id, tx)
    w.moonpay.setDown(true)
    expect((await w.deposit(ana.token, body)).body.error).toEqual({ code: 'upstream_error', message: 'Withdrawals are not available right now.' })
    w.moonpay.setDown(false)
    w.treasury.setCan(false)
    expect((await w.deposit(ana.token, body)).status).toBe(503)
    w.treasury.setCan(true)
    w.moonpay.sells.set(tx.id, { ...tx, baseCurrencyAmount: 50.01 })
    expect((await w.deposit(ana.token, body)).body.error).toMatchObject({ code: 'limit_reached', details: { limit: 'per_payment' } })
    expect(w.core.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE kind = 'withdraw'").get()).toEqual({ n: 0 })
    w.moonpay.sells.set(tx.id, tx)
    expect((await w.deposit(ana.token, body)).status).toBe(200)
  })

  it('the same sale again before approving replaces the open approval (the earlier one can no longer be sent)', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const s = await w.session(ana.token)
    const tx = w.sale(s.body.externalId)
    const body = { externalId: s.body.externalId, transactionId: tx.id, depositWalletAddress: MP_DEPOSIT }
    const first = await w.deposit(ana.token, body)
    const second = await w.deposit(ana.token, body)
    expect(second.status).toBe(200)
    expect(second.body.intent.id).not.toBe(first.body.intent.id)
    expect(intents.byId(w.core, first.body.intent.id)?.status).toBe('failed')
    expect((await w.h.submit(ana, first.body.prepared)).status).toBe(403)
    expect((await w.h.submit(ana, second.body.prepared)).body.status).toBe('validated')
    await w.h.settle()
    expect(w.treasury.payments).toHaveLength(1)
    expect(getBalance(w.core, ana.user.id).availableMinor).toBe(5000 - 1965)
  })

  it('is 404 feature_off with the flag off (deposit and status)', async () => {
    const w = world({ env: { FEATURE_WITHDRAW: '0' } })
    const ana = await w.h.signUp('ana')
    expect((await w.deposit(ana.token, { externalId: 'ramp_x', transactionId: 'y' })).body.error.code).toBe('feature_off')
    expect((await w.status(ana.token, 'int_x')).body.error.code).toBe('feature_off')
    expect((await w.h.json('POST', '/v1/ramp/sell/deposit', { body: { externalId: 'ramp_x', transactionId: 'y' } })).status).toBe(404)
  })
})

describe('the treasury payment: once, settled from the ledger, refunded when it fails', () => {
  it('a failed payment (tec) gives the dollars back through the pool, once, and the screen says so', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    w.treasury.modes.push('tec')
    const { id } = await w.withdraw(ana)
    expect(w.treasury.payments).toHaveLength(1)
    expect(intents.byId(w.core, id)).toMatchObject({ status: 'failed', failure: { code: 'withdraw_failed' } })
    const refund = withdrawals.byIntent(w.core.db, id)!.refundIntentId!
    expect(intents.byId(w.core, refund)).toMatchObject({ kind: 'topup', status: 'paid_out', toUserId: ana.user.id, amountMinor: 1965 })
    expect(w.h.pool.payouts).toEqual([expect.objectContaining({ intentId: refund, to: ana.user.address, amountMinor: 1965 })])
    expect(getBalance(w.core, ana.user.id)).toMatchObject({ availableMinor: 5000, pendingMinor: 0 })
    expect((await w.status(ana.token, id)).body).toMatchObject({ status: 'failed', refunded: true, message: "This withdrawal didn't go through. The money is back in your balance." })
    await w.core.receivedHandlers.get('withdraw')!(w.core, id)
    await w.h.app.core.idle()
    expect(w.treasury.payments).toHaveLength(1)
    expect(w.h.pool.payouts).toHaveLength(1)
  })

  it('an outcome not known yet stays "sending"; the scan settles it from the stored hash (validated, or past its LastLedgerSequence)', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    w.treasury.modes.push('unknown', 'throwAfterSign')
    const a = await w.withdraw(ana, { baseCurrencyAmount: 20 })
    expect((await w.status(ana.token, a.id)).body.status).toBe('sending')
    const b = await w.withdraw(ana, { baseCurrencyAmount: 21 })
    expect(withdrawals.byIntent(w.core.db, b.id)).toMatchObject({ status: 'sent', payLls: 120 })
    // a landed; b never reached the ledger and its LastLedgerSequence passed.
    w.treasury.ledger.set(withdrawals.byIntent(w.core.db, a.id)!.payHash!, { validated: true, engineResult: 'tesSUCCESS' })
    w.treasury.setIndex(121)
    await w.scan()
    expect(withdrawals.byIntent(w.core.db, a.id)?.status).toBe('delivered')
    expect(withdrawals.byIntent(w.core.db, b.id)?.status).toBe('failed')
    expect(w.treasury.payments).toHaveLength(2) // nothing paid twice
    expect(getBalance(w.core, ana.user.id).availableMinor).toBe(5000 - 2000)
  })

  it('a payment that could not be signed (network) is tried again by the next pass', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    w.treasury.modes.push('throwBeforeSign')
    const { id } = await w.withdraw(ana)
    expect(withdrawals.byIntent(w.core.db, id)?.status).toBe('paying')
    expect(w.treasury.payments).toHaveLength(0)
    await w.scan()
    expect(withdrawals.byIntent(w.core.db, id)?.status).toBe('delivered')
    expect(w.treasury.payments).toHaveLength(1)
  })

  it('two passes at the same time pay once (the in-process lock, and the stored hash: a second signature is never submitted)', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    w.treasury.modes.push('throwBeforeSign')
    const { id } = await w.withdraw(ana)
    const run = w.core.receivedHandlers.get('withdraw')!
    await Promise.all([run(w.core, id), run(w.core, id), w.scan()])
    expect(w.treasury.payments).toHaveLength(1)
    expect(withdrawals.byIntent(w.core.db, id)?.status).toBe('delivered')
  })

  it('MoonPay no longer waiting (or asking another amount or address) when the pool confirms: nothing is paid, the dollars come back', async () => {
    for (const change of [{ status: 'failed' }, { baseCurrencyAmount: 25 }, { depositWallet: { walletAddress: OTHER } }]) {
      const w = world()
      const ana = await w.h.signUp('ana')
      const s = await w.session(ana.token)
      const tx = w.sale(s.body.externalId)
      const d = await w.deposit(ana.token, { externalId: s.body.externalId, transactionId: tx.id, depositWalletAddress: MP_DEPOSIT })
      w.moonpay.sells.set(tx.id, { ...tx, ...change })
      await w.h.submit(ana, d.body.prepared)
      await w.h.settle()
      expect(w.treasury.payments, JSON.stringify(change)).toEqual([])
      expect(withdrawals.byIntent(w.core.db, d.body.intent.id)?.status).toBe('failed')
      expect(getBalance(w.core, ana.user.id).availableMinor).toBe(5000)
    }
  })
})

describe("MoonPay's status: signed sell webhooks and the poll", () => {
  it('completed -> "Paid out to your card"; a failure after our payment is flagged for a manual return; unsigned events change nothing', async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const a = await w.withdraw(ana, { baseCurrencyAmount: 20 })
    const unsigned = JSON.stringify({ type: 'sell_transaction_updated', data: { ...a.tx, status: 'completed' } })
    expect((await w.h.call('POST', '/v1/webhooks/moonpay', { body: unsigned, headers: { 'moonpay-signature-v2': 't=1,s=00' } })).status).toBe(401)
    expect((await w.status(ana.token, a.id)).body.status).toBe('sent')
    expect((await w.webhook({ type: 'sell_transaction_updated', data: { ...a.tx, status: 'pending' } })).status).toBe(200)
    expect((await w.status(ana.token, a.id)).body).toMatchObject({ status: 'sent', moonpayStatus: 'pending' })
    await w.webhook({ type: 'sell_transaction_updated', data: { ...a.tx, status: 'completed' } })
    expect((await w.status(ana.token, a.id)).body.status).toBe('paid_out')

    const b = await w.withdraw(ana, { baseCurrencyAmount: 20 })
    await w.webhook({ type: 'sell_transaction_failed', data: { ...b.tx, status: 'failed', failureReason: 'card declined' } })
    expect((await w.status(ana.token, b.id)).body).toMatchObject({ status: 'failed', refunded: false, message: "MoonPay couldn't pay this out. Our team has been told and will return your money." })
    expect(withdrawals.byIntent(w.core.db, b.id)).toMatchObject({ status: 'moonpay_failed', reason: 'card declined' })
  })

  it("the poll asks MoonPay about what we paid when no webhook comes (another user's status stays private)", async () => {
    const w = world()
    const ana = await w.h.signUp('ana')
    const bo = await w.h.signUp('bob')
    const a = await w.withdraw(ana, { baseCurrencyAmount: 20 })
    w.moonpay.sells.set(a.tx.id, { ...a.tx, status: 'completed' })
    await w.scan()
    expect((await w.status(ana.token, a.id)).body).toMatchObject({ status: 'paid_out', moonpayStatus: 'completed' })
    expect((await w.status(bo.token, a.id)).status).toBe(404)
  })
})
