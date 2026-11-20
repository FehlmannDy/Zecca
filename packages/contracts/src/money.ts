// Integer minor units everywhere (1 unit = 1 cent). Format only at the last moment. No floats.

/** Fee in minor units for an amount and a rate in basis points, rounded half up. */
export function feeMinor(amountMinor: number, bps: number): number {
  assertInt(amountMinor, 'amountMinor')
  assertInt(bps, 'bps')
  return Math.floor((amountMinor * bps + 5_000) / 10_000)
}

/** "$12.00", "$1,234.56". Negative amounts get a leading minus. */
export function formatUsd(minor: number, opts: { sign?: boolean } = {}): string {
  assertInt(minor, 'minor')
  const neg = minor < 0
  const { dollars, cents } = splitUsd(Math.abs(minor))
  const s = `$${dollars}.${cents}`
  if (neg) return `-${s}`
  return opts.sign ? `+${s}` : s
}

/** Dollars with thousands separators, and two-digit cents, for setting cents smaller. */
export function splitUsd(minor: number): { dollars: string; cents: string } {
  assertInt(minor, 'minor')
  const abs = Math.abs(minor)
  const dollars = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = (abs % 100).toString().padStart(2, '0')
  return { dollars, cents }
}

/** Parse what a person typed ("12", "12.5", "12.50", "1,200.00") into minor units, or null. No float arithmetic. */
export function parseUsdInput(input: string): number | null {
  const s = input.trim().replace(/^\$/, '').replace(/,/g, '')
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(s)
  if (!m) return null
  const cents = (m[2] ?? '').padEnd(2, '0')
  return Number(m[1]) * 100 + Number(cents)
}

/** Words for screen readers: "four dollars fifty" style is overkill; "$4.50" -> "4 dollars 50". */
export function spokenUsd(minor: number): string {
  const { dollars, cents } = splitUsd(minor)
  const d = dollars.replace(/,/g, '')
  return cents === '00' ? `${d} dollars` : `${d} dollars ${Number(cents)}`
}

/** XRP drops -> "12.5 XRP" style string with up to 6 decimals, trailing zeros trimmed. */
export function formatDrops(drops: number): string {
  assertInt(drops, 'drops')
  const whole = Math.floor(drops / 1_000_000)
  const frac = (drops % 1_000_000).toString().padStart(6, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** Milligrams -> grams string with up to 3 decimals. */
export function formatGrams(mg: number): string {
  assertInt(mg, 'mg')
  const whole = Math.floor(mg / 1000)
  const frac = (mg % 1000).toString().padStart(3, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

function assertInt(n: number, name: string): void {
  if (!Number.isSafeInteger(n)) throw new TypeError(`${name} must be a safe integer, got ${n}`)
}
