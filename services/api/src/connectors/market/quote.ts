// Market quotes (SPEC §4.9, §4.13): integers only, cents and milligrams. Buy at the feed price plus half the spread,
// sell at the feed price minus half; the buyer is charged what the whole milligrams cost (rounded up to the cent),
// the seller is paid what they are worth (rounded down). The spread is what Zecca keeps.

export class QuoteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuoteError'
  }
}

function int(n: unknown, name: string, min = 0): number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min) throw new TypeError(`${name} must be an integer >= ${min}, got ${String(n)}`)
  return n
}

/** Half the spread on a per-gram price, rounded half up: price * bps / 20 000. */
export function halfSpreadMinor(priceMinor: number, spreadBps: number): number {
  int(priceMinor, 'priceMinor', 1)
  int(spreadBps, 'spreadBps')
  return Math.floor((priceMinor * spreadBps + 10_000) / 20_000)
}

export function sidePrices(priceMinor: number, spreadBps: number): { buyPriceMinor: number; sellPriceMinor: number } {
  const half = halfSpreadMinor(priceMinor, spreadBps)
  return { buyPriceMinor: priceMinor + half, sellPriceMinor: Math.max(1, priceMinor - half) }
}

/** Worth of `mg` milligrams at a per-gram price, rounded down to the cent. */
export function valueOfMg(mg: number, perGramMinor: number): number {
  return Math.floor((int(mg, 'mg') * int(perGramMinor, 'perGramMinor')) / 1000)
}

const costOfMg = (mg: number, perGramMinor: number) => Math.ceil((mg * perGramMinor) / 1000)

export type Quote = {
  quantityMg: number
  /** Buy: what the user pays. Sell: what the user receives. */
  amountMinor: number
  /** Per gram, the side's price. */
  unitPriceMinor: number
  /** What Zecca keeps: the difference to the feed value. */
  spreadMinor: number
  /** The quantity at the feed price, rounded down. */
  feedValueMinor: number
}

type QuoteIn = { priceMinor: number; spreadBps: number; amountMinor?: number; quantityMg?: number }

function oneOf(q: QuoteIn): { amountMinor: number } | { quantityMg: number } {
  if ((q.amountMinor === undefined) === (q.quantityMg === undefined)) throw new TypeError('give exactly one of amountMinor or quantityMg')
  return q.amountMinor !== undefined ? { amountMinor: int(q.amountMinor, 'amountMinor', 1) } : { quantityMg: int(q.quantityMg, 'quantityMg', 0) }
}

const TOO_SMALL = "That's less than the smallest amount you can trade."

export function quoteBuy(q: QuoteIn): Quote {
  const by = oneOf(q)
  const { buyPriceMinor } = sidePrices(q.priceMinor, q.spreadBps)
  const quantityMg = 'quantityMg' in by ? by.quantityMg : Math.floor((by.amountMinor * 1000) / buyPriceMinor)
  if (quantityMg < 1) throw new QuoteError(TOO_SMALL)
  const amountMinor = costOfMg(quantityMg, buyPriceMinor)
  const feedValueMinor = valueOfMg(quantityMg, q.priceMinor)
  return { quantityMg, amountMinor, unitPriceMinor: buyPriceMinor, spreadMinor: amountMinor - feedValueMinor, feedValueMinor }
}

export function quoteSell(q: QuoteIn): Quote {
  const by = oneOf(q)
  const { sellPriceMinor } = sidePrices(q.priceMinor, q.spreadBps)
  const quantityMg = 'quantityMg' in by ? by.quantityMg : Math.ceil((by.amountMinor * 1000) / sellPriceMinor)
  const amountMinor = valueOfMg(quantityMg, sellPriceMinor)
  if (quantityMg < 1 || amountMinor < 1) throw new QuoteError(TOO_SMALL)
  const feedValueMinor = valueOfMg(quantityMg, q.priceMinor)
  return { quantityMg, amountMinor, unitPriceMinor: sellPriceMinor, spreadMinor: feedValueMinor - amountMinor, feedValueMinor }
}

/** Troy ounce in grams is 31.1034768 exactly: cents per gram = usd * 100 / 31.1034768, rounded half up, in BigInt. */
const OZ_NANO_GRAMS = 311_034_768n // 31.1034768 g * 10^7

/** "3539.0" (US dollars per troy ounce, as a decimal string or a JSON number) -> cents per gram. */
export function perGramFromOunce(usdPerOunce: string | number): number {
  const s = typeof usdPerOunce === 'number' ? String(usdPerOunce) : usdPerOunce.trim()
  const m = /^(\d{1,9})(?:\.(\d{1,15}))?$/.exec(s)
  if (!m) throw new Error(`not a price: ${s}`)
  const frac = m[2] ?? ''
  const n = BigInt(m[1] + frac)
  const num = n * 1_000_000_000n // * 100 cents * 10^7
  const den = 10n ** BigInt(frac.length) * OZ_NANO_GRAMS
  const v = Number((2n * num + den) / (2n * den))
  if (v < 1) throw new Error(`price too small: ${s}`)
  return v
}
