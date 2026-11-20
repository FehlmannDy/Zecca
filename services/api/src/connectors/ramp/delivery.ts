// What we credit for a MoonPay delivery (D5: the amount DELIVERED on the Testnet ledger, never the quote), and the
// ledger check that comes first: validated, tesSUCCESS, a Payment to our treasury, Ripple's testnet RLUSD (or native XRP).
// Integer maths only: decimal strings become BigInt mantissas with a power of ten.

/** RLUSD's currency code on the XRPL (hex of "RLUSD"). */
export const RLUSD_HEX = '524C555344000000000000000000000000000000'
/** Ripple's RLUSD issuer on Testnet: what MoonPay's sandbox delivers (seen on the real delivery). */
export const RLUSD_TESTNET_ISSUER = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'

export type DeliveredCurrency = 'RLUSD' | 'XRP'

type Dec = { n: bigint; e: number } // value = n * 10^e

function parseDec(s: string): Dec {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m) throw new RangeError(`not a non-negative decimal: ${JSON.stringify(s)}`)
  const frac = m[2] ?? ''
  return { n: BigInt(m[1] + frac), e: Number(m[3] ?? 0) - frac.length }
}

const decOf = (x: number | string | undefined): Dec | undefined => {
  if (x === undefined || x === null) return undefined
  if (typeof x === 'number' && !(Number.isFinite(x) && x > 0)) return undefined
  try {
    const d = parseDec(String(x))
    return d.n > 0n ? d : undefined
  } catch {
    return undefined
  }
}

/** floor(num * 10^exp / den), all positive. */
function floorScaled(num: bigint, den: bigint, exp: number): number {
  const q = exp >= 0 ? (num * 10n ** BigInt(exp)) / den : num / (den * 10n ** BigInt(-exp))
  if (q > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('amount too large')
  return Number(q)
}

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 1) throw new RangeError(`scale must be a positive integer, got ${scale}`)
}

/** A delivered decimal string (units of a dollar token) times the sandbox scale, in cents, floored. */
export function decimalToMinor(value: string, scale: number): number {
  assertScale(scale)
  const d = parseDec(value)
  return floorScaled(d.n * BigInt(scale) * 100n, 1n, d.e)
}

/** The price MoonPay charged, from its transaction object: base (fiat) amount, quote (crypto) amount, USD per base unit. */
export type MoonPayPrice = { baseCurrencyAmount?: number; quoteCurrencyAmount?: number; usdRate?: number }

/**
 * Cents to credit. RLUSD is a dollar token: delivered x scale. XRP (MoonPay's fallback where RLUSD is not offered) is valued
 * at the price MoonPay charged for this purchase: delivered x baseCurrencyAmount x usdRate / quoteCurrencyAmount x scale.
 */
export function creditMinor(d: { currency: DeliveredCurrency; value: string }, scale: number, price: MoonPayPrice = {}): number {
  if (d.currency === 'RLUSD') return decimalToMinor(d.value, scale)
  assertScale(scale)
  const v = parseDec(d.value)
  const base = decOf(price.baseCurrencyAmount)
  const quote = decOf(price.quoteCurrencyAmount)
  const usd = decOf(price.usdRate)
  if (!base || !quote || !usd) throw new RangeError('no usable price on the MoonPay transaction for an XRP delivery')
  return floorScaled(v.n * BigInt(scale) * 100n * base.n * usd.n, quote.n, v.e + base.e + usd.e - quote.e)
}

export type DeliveryCheck =
  | { ok: true; currency: DeliveredCurrency; value: string }
  /** final: false means "look again later" (not found or not validated yet). */
  | { ok: false; final: boolean; reason: string }

/** Checks a rippled `tx` result (API v1 or v2 shape) against what we expect. */
export function checkDelivery(r: any, expect: { hash: string; treasury: string; currency: DeliveredCurrency }): DeliveryCheck {
  if (!r) return { ok: false, final: false, reason: 'not on the ledger yet' }
  if (r.validated !== true) return { ok: false, final: false, reason: 'not validated yet' }
  const no = (reason: string): DeliveryCheck => ({ ok: false, final: true, reason })
  const tx = r.tx_json ?? r
  const hash = String(r.hash ?? tx.hash ?? '')
  if (hash.toUpperCase() !== expect.hash.toUpperCase()) return no(`hash ${hash} is not ${expect.hash}`)
  const result = r.meta?.TransactionResult
  if (result !== 'tesSUCCESS') return no(`result ${result}`)
  if (tx.TransactionType !== 'Payment') return no(`TransactionType ${tx.TransactionType}`)
  if (tx.Destination !== expect.treasury) return no(`destination ${tx.Destination} is not our treasury`)
  const delivered = r.meta?.delivered_amount
  if (delivered === undefined || delivered === null || delivered === 'unavailable') return no('no delivered_amount')
  if (expect.currency === 'XRP') {
    if (typeof delivered !== 'string' || !/^\d+$/.test(delivered)) return no('currency: expected XRP')
    return { ok: true, currency: 'XRP', value: `${delivered}e-6` }
  }
  if (typeof delivered !== 'object' || delivered.currency !== RLUSD_HEX) return no('currency: expected RLUSD')
  if (delivered.issuer !== RLUSD_TESTNET_ISSUER) return no(`issuer ${delivered.issuer} is not ${RLUSD_TESTNET_ISSUER}`)
  if (typeof delivered.value !== 'string') return no('delivered_amount has no value')
  return { ok: true, currency: 'RLUSD', value: delivered.value }
}
