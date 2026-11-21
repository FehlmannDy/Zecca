import { describe, expect, it } from 'vitest'
import { RLUSD_HEX, RLUSD_TESTNET_ISSUER } from './delivery'
import { checkSellTx, debitMinor, paymentAmount, resolveDestination, xrpDrops } from './sell'

const DEST = 'rUZTCFB6zPyeEmDhrAVqVbBaLPWrzjKCQz'
const OTHER = 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS'

describe('debitMinor: the dollars a crypto amount costs, in cents, rounded up (never send more than we take)', () => {
  it('RLUSD is a dollar token: 1:1', () => {
    expect(debitMinor('RLUSD', '19.65')).toBe(1965)
    expect(debitMinor('RLUSD', '25')).toBe(2500)
    expect(debitMinor('RLUSD', '19.651')).toBe(1966)
    expect(debitMinor('RLUSD', '0.001')).toBe(1)
  })
  it("XRP is valued at MoonPay's own usdRate for this sale", () => {
    expect(debitMinor('XRP', '21.77', 2.3)).toBe(5008) // 50.071 -> 50.08
    expect(debitMinor('XRP', '10', 2.5)).toBe(2500)
    expect(debitMinor('XRP', '10', '2.5')).toBe(2500)
  })
  it('refuses an XRP amount without a usable rate, and anything that is not a positive decimal', () => {
    expect(() => debitMinor('XRP', '10')).toThrow(RangeError)
    expect(() => debitMinor('XRP', '10', 0)).toThrow(RangeError)
    expect(() => debitMinor('XRP', '10', Number.NaN)).toThrow(RangeError)
    expect(() => debitMinor('RLUSD', '-1')).toThrow(RangeError)
    expect(() => debitMinor('RLUSD', 'abc')).toThrow(RangeError)
  })
})

describe('paymentAmount: what the Testnet treasury pays MoonPay', () => {
  it('XRP in whole drops, RLUSD as an amount of Ripple testnet RLUSD', () => {
    expect(xrpDrops('21.77')).toBe('21770000')
    expect(xrpDrops('1e-6')).toBe('1')
    expect(paymentAmount('XRP', '21.77')).toBe('21770000')
    expect(paymentAmount('RLUSD', '19.65')).toEqual({ currency: RLUSD_HEX, issuer: RLUSD_TESTNET_ISSUER, value: '19.65' })
  })
  it('refuses XRP finer than a drop', () => {
    expect(() => xrpDrops('1.0000001')).toThrow(RangeError)
  })
})

/** A MoonPay sell transaction as GET /v3/sell_transactions/:id returns it (the fields we read). */
const sellTx = (o: Record<string, unknown> = {}) => ({
  id: 'mp-sell-1',
  status: 'waitingForDeposit',
  externalTransactionId: 'ramp_1',
  baseCurrencyAmount: 19.65,
  quoteCurrencyAmount: 18.9,
  usdRate: 1,
  baseCurrency: { code: 'rlusd_xrp' },
  quoteCurrency: { code: 'usd' },
  ...o,
})
const expect1 = { transactionId: 'mp-sell-1', externalId: 'ramp_1', currencyCode: 'rlusd_xrp' }

describe("checkSellTx: MoonPay's record, never the browser's", () => {
  it('reads the amount, currency, rate and deposit wallet of our own sale', () => {
    expect(checkSellTx(sellTx(), expect1)).toEqual({ ok: true, status: 'waitingForDeposit', currency: 'RLUSD', cryptoAmount: '19.65', usdRate: 1 })
    const x = checkSellTx(sellTx({ baseCurrency: { code: 'xrp' }, baseCurrencyAmount: 21.77, usdRate: 2.3, depositWallet: { walletAddress: DEST, walletAddressTag: '12345' } }), { ...expect1, currencyCode: 'xrp' })
    expect(x).toEqual({ ok: true, status: 'waitingForDeposit', currency: 'XRP', cryptoAmount: '21.77', usdRate: 2.3, depositAddress: DEST, depositTag: '12345' })
  })
  it('refuses another sale, another session, another currency, or no amount', () => {
    expect(checkSellTx(sellTx({ id: 'other' }), expect1)).toMatchObject({ ok: false })
    expect(checkSellTx(sellTx({ externalTransactionId: 'ramp_2' }), expect1)).toMatchObject({ ok: false })
    expect(checkSellTx(sellTx({ externalTransactionId: null }), expect1)).toMatchObject({ ok: false })
    expect(checkSellTx(sellTx({ baseCurrency: { code: 'btc' } }), expect1)).toMatchObject({ ok: false })
    expect(checkSellTx(sellTx({ baseCurrency: { code: 'xrp' } }), expect1)).toMatchObject({ ok: false })
    expect(checkSellTx(sellTx({ baseCurrency: { code: 'constructor' } }), { ...expect1, currencyCode: 'constructor' })).toMatchObject({ ok: false })
    expect(checkSellTx(sellTx({ baseCurrencyAmount: 0 }), expect1)).toMatchObject({ ok: false })
    expect(checkSellTx(sellTx({ baseCurrencyAmount: 'abc' }), expect1)).toMatchObject({ ok: false })
    expect(checkSellTx(sellTx({ baseCurrencyAmount: '19.65' }), expect1)).toMatchObject({ ok: true, cryptoAmount: '19.65' })
    expect(checkSellTx(sellTx({ baseCurrency: { code: 'xrp' }, usdRate: null }), { ...expect1, currencyCode: 'xrp' })).toMatchObject({ ok: false })
    expect(checkSellTx(null, expect1)).toMatchObject({ ok: false })
  })
})

describe('resolveDestination: where the treasury pays', () => {
  it("prefers MoonPay's deposit wallet, and takes the widget's when MoonPay's record has none", () => {
    expect(resolveDestination({ moonpay: { address: DEST, tag: '7' }, widget: { address: DEST, tag: 7 } })).toEqual({ ok: true, address: DEST, tag: 7, source: 'moonpay' })
    expect(resolveDestination({ widget: { address: DEST, tag: '42' } })).toEqual({ ok: true, address: DEST, tag: 42, source: 'widget' })
    expect(resolveDestination({ moonpay: { address: DEST }, widget: { address: DEST, tag: 9 } })).toEqual({ ok: true, address: DEST, tag: 9, source: 'moonpay' })
    expect(resolveDestination({ widget: { address: DEST, tag: '' } })).toEqual({ ok: true, address: DEST, source: 'widget' })
  })
  it("refuses a widget address or tag that MoonPay contradicts, a bad address or tag, our own treasury, or nothing", () => {
    expect(resolveDestination({ moonpay: { address: DEST }, widget: { address: OTHER } })).toMatchObject({ ok: false })
    expect(resolveDestination({ moonpay: { address: DEST, tag: 1 }, widget: { address: DEST, tag: 2 } })).toMatchObject({ ok: false })
    expect(resolveDestination({ widget: { address: 'not-an-address' } })).toMatchObject({ ok: false })
    expect(resolveDestination({ widget: { address: DEST, tag: '-1' } })).toMatchObject({ ok: false })
    expect(resolveDestination({ widget: { address: DEST, tag: 4294967296 } })).toMatchObject({ ok: false })
    expect(resolveDestination({ widget: { address: DEST, tag: '1.5' } })).toMatchObject({ ok: false })
    expect(resolveDestination({ widget: { address: DEST } }, DEST)).toMatchObject({ ok: false })
    expect(resolveDestination({})).toMatchObject({ ok: false })
  })
})
