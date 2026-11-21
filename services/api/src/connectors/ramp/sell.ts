// MoonPay sell (withdrawal, SPEC §4.5), the pure parts: what MoonPay's own sell transaction must say before we take the
// user's dollars, how many cents a crypto amount costs (RLUSD 1:1, XRP at MoonPay's rate for this sale, rounded up so we
// never send more than we take), the Testnet amount the treasury pays, and where it pays. Integer maths only.
import xrpl from 'xrpl'
import { RLUSD_HEX, RLUSD_TESTNET_ISSUER, type DeliveredCurrency } from './delivery'

/** MoonPay currency code -> what the treasury sends. Same pair as the top-up (rlusd_xrp, or xrp where RLUSD is not offered). */
export const SELL_CURRENCY: Record<string, DeliveredCurrency> = { rlusd_xrp: 'RLUSD', xrp: 'XRP' }
/** MoonPay's sell minimums are 19.65 RLUSD and 21.77 XRP: withdrawals start at $20. */
export const MIN_SELL_USD = 20

type Dec = { n: bigint; e: number } // value = n * 10^e

function parseDec(s: string): Dec {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m) throw new RangeError(`not a non-negative decimal: ${JSON.stringify(s)}`)
  const frac = m[2] ?? ''
  return { n: BigInt(m[1] + frac), e: Number(m[3] ?? 0) - frac.length }
}

/** A positive decimal from a number or a decimal string, or undefined. */
function positiveDec(x: unknown): { s: string; d: Dec } | undefined {
  if (typeof x === 'number' && !(Number.isFinite(x) && x > 0)) return undefined
  if (typeof x !== 'number' && typeof x !== 'string') return undefined
  const s = String(x).trim()
  try {
    const d = parseDec(s)
    return d.n > 0n ? { s, d } : undefined
  } catch {
    return undefined
  }
}

/** ceil(n * 10^e), as a safe integer. */
function ceilScaled(n: bigint, e: number): number {
  const q = e >= 0 ? n * 10n ** BigInt(e) : (n + 10n ** BigInt(-e) - 1n) / 10n ** BigInt(-e)
  if (q > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('amount too large')
  return Number(q)
}

/** Cents the user pays for `amount` of the currency: RLUSD 1:1, XRP x usdRate (USD per XRP, from MoonPay's sell transaction). */
export function debitMinor(currency: DeliveredCurrency, amount: string, usdRate?: number | string): number {
  const v = positiveDec(amount)
  if (!v) throw new RangeError(`not a positive decimal: ${JSON.stringify(amount)}`)
  if (currency === 'RLUSD') return ceilScaled(v.d.n * 100n, v.d.e)
  const r = positiveDec(usdRate)
  if (!r) throw new RangeError('no usable usdRate on the MoonPay sell transaction for XRP')
  return ceilScaled(v.d.n * r.d.n * 100n, v.d.e + r.d.e)
}

/** XRP decimal -> whole drops (string). Finer than a drop cannot be paid: refused. */
export function xrpDrops(amount: string): string {
  const v = positiveDec(amount)
  if (!v) throw new RangeError(`not a positive decimal: ${JSON.stringify(amount)}`)
  const e = v.d.e + 6
  if (e >= 0) return (v.d.n * 10n ** BigInt(e)).toString()
  const div = 10n ** BigInt(-e)
  if (v.d.n % div !== 0n) throw new RangeError(`${amount} XRP is finer than a drop`)
  return (v.d.n / div).toString()
}

export type TreasuryAmount = string | { currency: string; issuer: string; value: string }

/** The Payment Amount the treasury sends MoonPay. */
export function paymentAmount(currency: DeliveredCurrency, amount: string): TreasuryAmount {
  if (currency === 'XRP') return xrpDrops(amount)
  if (!positiveDec(amount)) throw new RangeError(`not a positive decimal: ${JSON.stringify(amount)}`)
  return { currency: RLUSD_HEX, issuer: RLUSD_TESTNET_ISSUER, value: amount }
}

export type SellCheck =
  | { ok: true; status: string; currency: DeliveredCurrency; cryptoAmount: string; usdRate?: number; depositAddress?: string; depositTag?: string | number }
  | { ok: false; reason: string }

/**
 * MoonPay's sell transaction (GET /v3/sell_transactions/:id, or a signed sell_transaction_* webhook) checked against our
 * session: the same sale, our externalTransactionId, the session's currency, a positive amount (and a rate for XRP).
 */
export function checkSellTx(tx: any, expect: { transactionId: string; externalId: string; currencyCode: string }): SellCheck {
  const no = (reason: string): SellCheck => ({ ok: false, reason })
  if (!tx || typeof tx !== 'object') return no('no sell transaction')
  if (tx.id !== expect.transactionId) return no(`sell transaction ${tx.id} is not ${expect.transactionId}`)
  if (tx.externalTransactionId !== expect.externalId) return no(`externalTransactionId ${tx.externalTransactionId} is not ${expect.externalId}`)
  const code = String(tx.baseCurrency?.code ?? '')
  if (code !== expect.currencyCode || !Object.hasOwn(SELL_CURRENCY, code)) return no(`currency ${code} is not ${expect.currencyCode}`)
  const currency = SELL_CURRENCY[code]
  const amount = positiveDec(tx.baseCurrencyAmount)
  if (!amount) return no(`baseCurrencyAmount ${JSON.stringify(tx.baseCurrencyAmount)} is not a positive amount`)
  const rate = positiveDec(tx.usdRate)
  if (currency === 'XRP' && !rate) return no('no usdRate for an XRP sale')
  const wallet = tx.depositWallet && typeof tx.depositWallet === 'object' ? tx.depositWallet : undefined
  const address = wallet?.walletAddress ?? tx.depositWalletAddress
  const tag = wallet?.walletAddressTag ?? tx.depositWalletAddressTag
  return {
    ok: true,
    status: String(tx.status ?? ''),
    currency,
    cryptoAmount: amount.s,
    ...(rate ? { usdRate: Number(rate.s) } : {}),
    ...(typeof address === 'string' && address ? { depositAddress: address } : {}),
    ...((typeof tag === 'string' && tag !== '') || typeof tag === 'number' ? { depositTag: tag } : {}),
  }
}

type Wallet = { address?: string; tag?: string | number | null }
export type Destination = { ok: true; address: string; tag?: number; source: 'moonpay' | 'widget' } | { ok: false; reason: string }

/** undefined: no tag; null: not a valid destination tag (an integer from 0 to 2^32 - 1). */
function tagOf(t: Wallet['tag']): number | undefined | null {
  if (t === undefined || t === null || t === '') return undefined
  const s = String(t).trim()
  if (!/^\d{1,10}$/.test(s)) return null
  const n = Number(s)
  return n <= 0xffffffff ? n : null
}

/**
 * Where the treasury pays: MoonPay's deposit wallet when its record has one (the widget's must then agree), else the
 * address the widget gave (onInitiateDeposit only carries depositWalletAddress). Never our own treasury.
 */
export function resolveDestination(o: { moonpay?: Wallet; widget?: Wallet }, treasury?: string): Destination {
  const no = (reason: string): Destination => ({ ok: false, reason })
  const mp = o.moonpay?.address ? o.moonpay : undefined
  const wd = o.widget?.address ? o.widget : undefined
  const pick = mp ?? wd
  if (!pick?.address) return no('no deposit address')
  if (mp && wd && wd.address !== mp.address) return no('the widget deposit address differs from MoonPay record')
  const mpTag = tagOf(mp?.tag)
  const wdTag = tagOf(wd?.tag)
  if (mpTag === null || wdTag === null) return no('destination tag is not valid')
  if (mpTag !== undefined && wdTag !== undefined && mpTag !== wdTag) return no('the widget destination tag differs from MoonPay record')
  if (!xrpl.isValidClassicAddress(pick.address)) return no(`deposit address ${pick.address} is not a valid address`)
  if (treasury && pick.address === treasury) return no('deposit address is our own treasury')
  const tag = mpTag ?? wdTag
  return { ok: true, address: pick.address, ...(tag !== undefined ? { tag } : {}), source: mp ? 'moonpay' : 'widget' }
}
