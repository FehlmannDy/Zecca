import { describe, expect, it } from 'vitest'
import { RLUSD_HEX, RLUSD_TESTNET_ISSUER, checkDelivery, creditMinor, decimalToMinor } from './delivery'

// The real sandbox delivery (MOONPAY_REPORT.md): 0.2852 RLUSD for a 28.52 RLUSD quote.
const HASH = '548D695E91F1F48720D64F0380C084DE3E0A6A4F97CA1599B79324FB5A1F8939'
const TREASURY = 'rPjBkPhgJENnEJuphuhwNdJp5gvL5wiDhS'
const rlusd = (value = '0.2852', issuer = RLUSD_TESTNET_ISSUER) => ({ currency: RLUSD_HEX, issuer, value })
function txResult(o: { result?: string; validated?: boolean; destination?: string; delivered?: unknown; type?: string; hash?: string; v1?: boolean } = {}) {
  const tx = { TransactionType: o.type ?? 'Payment', Account: 'rUZTCFB6zPyeEmDhrAVqVbBaLPWrzjKCQz', Destination: o.destination ?? TREASURY, DeliverMax: rlusd('28.52') }
  return {
    ...(o.v1 ? tx : { tx_json: tx }),
    hash: o.hash ?? HASH,
    validated: o.validated ?? true,
    meta: { TransactionResult: o.result ?? 'tesSUCCESS', delivered_amount: 'delivered' in o ? o.delivered : rlusd() },
  }
}
const expectRlusd = { hash: HASH, treasury: TREASURY, currency: 'RLUSD' as const }

describe('decimalToMinor: delivered decimal string x scale -> cents, integer maths only', () => {
  it('credits the delivered 0.2852 RLUSD times the sandbox scale 100 as $28.52', () => {
    expect(decimalToMinor('0.2852', 100)).toBe(2852)
    expect(decimalToMinor('0.2852', 1)).toBe(28)
  })
  it('handles integers, trailing zeros, exponents, and floors (never more than delivered)', () => {
    expect(decimalToMinor('25', 1)).toBe(2500)
    expect(decimalToMinor('25.000000', 1)).toBe(2500)
    expect(decimalToMinor('0.29', 1)).toBe(29) // 0.29 * 100 is 28.999999999999996 in floats
    expect(decimalToMinor('1.005', 1)).toBe(100)
    expect(decimalToMinor('0.009999', 1)).toBe(0)
    expect(decimalToMinor('2.852e-1', 100)).toBe(2852)
    expect(decimalToMinor('1E2', 1)).toBe(10000)
    expect(decimalToMinor('285200e-6', 1)).toBe(28)
  })
  it('refuses negatives, garbage, a bad scale and amounts past a safe integer', () => {
    for (const bad of ['-1', '', 'abc', '1.2.3', '0x10', ' 1', 'NaN']) expect(() => decimalToMinor(bad, 1), bad).toThrow()
    expect(() => decimalToMinor('1', 0)).toThrow()
    expect(() => decimalToMinor('1', 1.5)).toThrow()
    expect(() => decimalToMinor('1e20', 1)).toThrow()
  })
})

describe('creditMinor: RLUSD is dollars; XRP at the price MoonPay itself charged', () => {
  it('RLUSD: delivered x scale', () => {
    expect(creditMinor({ currency: 'RLUSD', value: '0.2852' }, 100)).toBe(2852)
  })
  it('XRP: delivered x (base amount x usdRate / quote amount) x scale, floored', () => {
    // $26.30 bought 10 XRP (usdRate 1 for a USD base): $2.63 per XRP. Sandbox delivered 0.1 XRP (100000 drops), scale 100.
    expect(creditMinor({ currency: 'XRP', value: '100000e-6' }, 100, { baseCurrencyAmount: 26.3, quoteCurrencyAmount: 10, usdRate: 1 })).toBe(2630)
    // EUR base: 26.30 EUR, usdRate 1.09732 USD per EUR, 10 XRP quoted, 10 XRP delivered, no scale: 26.3 * 1.09732 = 28.859516 -> $28.85
    expect(creditMinor({ currency: 'XRP', value: '10000000e-6' }, 1, { baseCurrencyAmount: 26.3, quoteCurrencyAmount: 10, usdRate: 1.09732 })).toBe(2885)
  })
  it('XRP without a usable price from MoonPay refuses to guess', () => {
    expect(() => creditMinor({ currency: 'XRP', value: '1' }, 1, {})).toThrow(/price/)
    expect(() => creditMinor({ currency: 'XRP', value: '1' }, 1, { baseCurrencyAmount: 26.3, quoteCurrencyAmount: 0, usdRate: 1 })).toThrow(/price/)
  })
})

describe('checkDelivery: confirm on the Testnet ledger before crediting', () => {
  it('accepts the real delivery: validated, tesSUCCESS, our treasury, Ripple testnet RLUSD, delivered_amount', () => {
    expect(checkDelivery(txResult(), expectRlusd)).toEqual({ ok: true, currency: 'RLUSD', value: '0.2852' })
    expect(checkDelivery(txResult({ v1: true }), expectRlusd)).toEqual({ ok: true, currency: 'RLUSD', value: '0.2852' })
    expect(checkDelivery(txResult({ hash: HASH.toLowerCase() }), expectRlusd).ok).toBe(true)
  })

  it('waits (not final) while the tx is missing or not validated yet', () => {
    expect(checkDelivery(null, expectRlusd)).toEqual({ ok: false, final: false, reason: 'not on the ledger yet' })
    expect(checkDelivery(txResult({ validated: false }), expectRlusd)).toEqual({ ok: false, final: false, reason: 'not validated yet' })
  })

  it('refuses for good: wrong result, wrong destination, wrong issuer, wrong currency, not a payment, no delivered_amount, other hash', () => {
    const cases: [string, unknown][] = [
      ['tecPATH_PARTIAL', txResult({ result: 'tecPATH_PARTIAL' })],
      ['destination', txResult({ destination: 'rDhpmiPq4BVBDWMVdSrmkgt8thKyRzGV1p' })],
      ['issuer', txResult({ delivered: rlusd('0.2852', 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De') })],
      ['currency', txResult({ delivered: { currency: 'USD', issuer: RLUSD_TESTNET_ISSUER, value: '1' } })],
      ['currency', txResult({ delivered: '285200' })],
      ['TransactionType', txResult({ type: 'EscrowFinish' })],
      ['delivered_amount', txResult({ delivered: 'unavailable' })],
      ['delivered_amount', txResult({ delivered: undefined })],
      ['hash', txResult({ hash: 'AB'.repeat(32) })],
    ]
    for (const [why, r] of cases) {
      const c = checkDelivery(r, expectRlusd)
      expect(c.ok, why).toBe(false)
      expect(!c.ok && c.final, why).toBe(true)
      expect(!c.ok && c.reason, why).toMatch(new RegExp(why, 'i'))
    }
  })

  it('XRP: native drops only, as a decimal of XRP', () => {
    expect(checkDelivery(txResult({ delivered: '285200' }), { ...expectRlusd, currency: 'XRP' })).toEqual({ ok: true, currency: 'XRP', value: '285200e-6' })
    expect(checkDelivery(txResult(), { ...expectRlusd, currency: 'XRP' }).ok).toBe(false)
  })
})
