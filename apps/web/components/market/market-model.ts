// Words and numbers for the market screens (UI.md §5.10). Integers in, text out; the server's quote is what the
// user approves, the estimate here only previews it while typing.
import { formatGrams, formatUsd, MetalSymbol, type MarketAsset } from '@zecca/contracts'

export const perGram = (minor: number) => `${formatUsd(minor)} / g`
export const gramsText = (mg: number) => `${formatGrams(mg)} g`

/** "1.5" or "0,087" grams -> milligrams; null when empty, zero, negative or finer than a milligram. */
export function parseGrams(input: string): number | null {
  const m = /^(\d{1,7})(?:[.,](\d{0,3}))?$/.exec(input.trim())
  if (!m) return null
  const mg = Number(m[1]) * 1000 + Number((m[2] ?? '').padEnd(3, '0'))
  return mg > 0 ? mg : null
}

/** Preview of the server's quote (same rounding): buy = what the amount affords, charged its cost; sell = proceeds. */
export function estimate(
  asset: Pick<MarketAsset, 'buyPriceMinor' | 'sellPriceMinor'>,
  side: 'buy' | 'sell',
  by: { amountMinor: number } | { quantityMg: number },
): { quantityMg: number; amountMinor: number } | null {
  if (side === 'buy') {
    const p = asset.buyPriceMinor
    const quantityMg = 'quantityMg' in by ? by.quantityMg : Math.floor((by.amountMinor * 1000) / p)
    if (quantityMg < 1) return null
    return { quantityMg, amountMinor: Math.ceil((quantityMg * p) / 1000) }
  }
  const p = asset.sellPriceMinor
  const quantityMg = 'quantityMg' in by ? by.quantityMg : Math.ceil((by.amountMinor * 1000) / p)
  const amountMinor = Math.floor((quantityMg * p) / 1000)
  return quantityMg >= 1 && amountMinor >= 1 ? { quantityMg, amountMinor } : null
}

export function changeText(pct: number | undefined): { text: string; spoken: string; dir: 'up' | 'down' | 'flat' } | null {
  if (pct === undefined || !Number.isFinite(pct)) return null
  const abs = Math.abs(pct).toFixed(1)
  if (pct > 0) return { text: `+${abs}%`, spoken: `up ${abs} percent`, dir: 'up' }
  if (pct < 0) return { text: `−${abs}%`, spoken: `down ${abs} percent`, dir: 'down' }
  return { text: '0.0%', spoken: 'unchanged', dir: 'flat' }
}

const r1 = (n: number) => String(Math.round(n * 10) / 10)

/** SVG path of a sparkline inside w x h (1 px inset top and bottom). Null with fewer than two points. */
export function sparkPath(values: number[], w: number, h: number): string | null {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const y = (v: number) => (max === min ? h / 2 : 1 + ((max - v) / (max - min)) * (h - 2))
  return values.map((v, i) => `${i ? 'L' : 'M'}${r1((i * w) / (values.length - 1))},${r1(y(v))}`).join(' ')
}

export const needsAuthorizeFirst = (res: { prepared: { kind: string } }) => res.prepared.kind === 'market_authorize'

export function tradeTitle(side: 'buy' | 'sell', name: string, q: { quantityMg: number; amountMinor: number }): string {
  return `${side === 'buy' ? 'Buy' : 'Sell'} ${gramsText(q.quantityMg)} of ${name.toLowerCase()} for ${formatUsd(q.amountMinor)}`
}

export function symbolOf(param: string): MetalSymbol | null {
  const p = MetalSymbol.safeParse(decodeURIComponent(param).toUpperCase())
  return p.success ? p.data : null
}

/** "Nov 20, 21:59" in the reader's time zone (or the one given). */
export function priceTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) })
}

/** Hover labels for the daily closes of the chart, oldest first. */
export function chartLabels(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const back = n - 1 - i
    return back === 0 ? 'Latest' : back === 1 ? 'Previous close' : `${back} closes ago`
  })
}
