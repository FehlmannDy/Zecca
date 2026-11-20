// PriceFeed (contracts/interfaces.ts) for gold, silver and palladium, per gram in integer cents (SPEC §4.9).
// Live: COMEX prices and daily closes from Yahoo Finance's public chart endpoint (no key); spot from gold-api.com
// (no key) when the chart is down; then the last good value (still dated); then a dated fixture that says it is one.
import type { MetalSymbol, PriceFeed } from '@zecca/contracts'
import { perGramFromOunce } from './quote'

export type PricePoint = { priceMinor: number; at: string; source: string }

/** Real COMEX daily closes (Yahoo Finance, fetched 2026-11-20 22:40 UTC), converted to cents per gram. */
export const FIXTURE = {
  at: '2026-11-20T21:59:57.000Z',
  source: 'Fixture: COMEX close 2026-11-20 (prices offline)',
  days: ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'],
  closes: {
    XAU: [13319, 13343, 13054, 12886, 12984, 13100, 13026, 12961, 12535, 12763, 12669, 13095, 13225, 13101, 13228, 12957, 12862, 12492, 12495, 12388, 12424, 12030, 11849, 11378],
    XAG: [186, 185, 176, 173, 174, 175, 172, 168, 158, 163, 159, 168, 168, 167, 169, 164, 167, 161, 158, 150, 152, 145, 142, 132],
    XPD: [3535, 3487, 3381, 3365, 3369, 3291, 3245, 3217, 3166, 3103, 2990, 3214, 3347, 3260, 3276, 3274, 3356, 3182, 3234, 3124, 3133, 3055, 2947, 2871],
  } satisfies Record<MetalSymbol, number[]>,
}

export function createFixtureFeed(): PriceFeed {
  return {
    async price(symbol) {
      return { priceMinor: FIXTURE.closes[symbol].at(-1)!, at: FIXTURE.at, source: FIXTURE.source }
    },
    async history(symbol, points) {
      return FIXTURE.closes[symbol].slice(-Math.max(0, points))
    },
  }
}

/** Percent change between the last two points, one decimal. Display only. */
export function change24hPct(history: number[]): number | undefined {
  if (history.length < 2) return undefined
  const a = history[history.length - 2]
  const b = history[history.length - 1]
  if (!a) return undefined
  return Math.round(((b - a) * 1000) / a) / 10
}

type Day = { day: string; minor: number }
type Loaded = { priceMinor: number; at: string; history: Day[] }

const dayOf = (iso: string) => iso.slice(0, 10)

/** Yahoo Finance v8 chart -> price per gram, its time, daily closes per gram (the newest replaced by the price). */
export function parseYahooChart(j: unknown): { priceMinor: number; at: string; history: number[] } {
  const l = yahooLoaded(j)
  return { priceMinor: l.priceMinor, at: l.at, history: l.history.map((d) => d.minor) }
}

function yahooLoaded(j: unknown): Loaded {
  const r = (j as { chart?: { result?: Array<Record<string, any>> } })?.chart?.result?.[0]
  if (!r?.meta || typeof r.meta.regularMarketPrice !== 'number' || typeof r.meta.regularMarketTime !== 'number') throw new Error('unexpected chart shape')
  if (r.meta.currency && r.meta.currency !== 'USD') throw new Error(`chart is in ${String(r.meta.currency)}`)
  const priceMinor = perGramFromOunce(r.meta.regularMarketPrice)
  const at = new Date(r.meta.regularMarketTime * 1000).toISOString()
  const ts: number[] = Array.isArray(r.timestamp) ? r.timestamp : []
  const closes: Array<number | null> = r.indicators?.quote?.[0]?.close ?? []
  const history: Day[] = []
  ts.forEach((t, i) => {
    const c = closes[i]
    if (typeof c === 'number' && c > 0) history.push({ day: dayOf(new Date(t * 1000).toISOString()), minor: perGramFromOunce(c) })
  })
  return { priceMinor, at, history: withNewest(history, { day: dayOf(at), minor: priceMinor }) }
}

function withNewest(history: Day[], p: Day): Day[] {
  const h = [...history]
  if (h.length && h[h.length - 1].day === p.day) h[h.length - 1] = p
  else h.push(p)
  return h
}

/** gold-api.com /price/<symbol> -> price per gram and its time. */
export function parseGoldApi(j: unknown): { priceMinor: number; at: string } {
  const o = j as { price?: unknown; updatedAt?: unknown }
  if (typeof o?.price !== 'number' || typeof o.updatedAt !== 'string' || Number.isNaN(Date.parse(o.updatedAt))) throw new Error('unexpected gold-api shape')
  return { priceMinor: perGramFromOunce(o.price), at: new Date(o.updatedAt).toISOString() }
}

const YAHOO: Record<MetalSymbol, string> = { XAU: 'GC=F', XAG: 'SI=F', XPD: 'PA=F' }

export type HttpFeedOptions = {
  fetch?: typeof fetch
  now?: () => number
  /** How long one load serves (default 5 minutes). */
  ttlMs?: number
  timeoutMs?: number
  log?: (m: string) => void
}

export function createHttpFeed(o: HttpFeedOptions = {}): PriceFeed {
  const doFetch = o.fetch ?? fetch
  const now = o.now ?? Date.now
  const ttl = o.ttlMs ?? 5 * 60_000
  const log = o.log ?? (() => {})
  const fixture = createFixtureFeed()
  const cache = new Map<MetalSymbol, { loaded: Loaded & { source: string }; until: number }>()
  const inflight = new Map<MetalSymbol, Promise<(Loaded & { source: string }) | null>>()

  const getJson = async (url: string) => {
    const r = await doFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Zecca demo)', accept: 'application/json' }, signal: AbortSignal.timeout(o.timeoutMs ?? 6000) })
    if (!r.ok) throw new Error(`${url} -> ${r.status}`)
    return r.json()
  }

  async function load(symbol: MetalSymbol): Promise<(Loaded & { source: string }) | null> {
    const prev = cache.get(symbol)?.loaded
    try {
      const l = yahooLoaded(await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[symbol])}?range=1mo&interval=1d`))
      return { ...l, source: 'COMEX via Yahoo Finance' }
    } catch (e) {
      log(`[market] chart ${symbol}: ${(e as Error).message}`)
    }
    try {
      const s = parseGoldApi(await getJson(`https://api.gold-api.com/price/${symbol}`))
      return { ...s, history: withNewest(prev?.history ?? [], { day: dayOf(s.at), minor: s.priceMinor }), source: 'gold-api.com' }
    } catch (e) {
      log(`[market] spot ${symbol}: ${(e as Error).message}`)
    }
    return prev ?? null
  }

  async function get(symbol: MetalSymbol): Promise<(Loaded & { source: string }) | null> {
    const c = cache.get(symbol)
    if (c && c.until > now()) return c.loaded
    let p = inflight.get(symbol)
    if (!p) {
      p = load(symbol).then((l) => {
        if (l) cache.set(symbol, { loaded: l, until: now() + ttl })
        return l
      })
      p.finally(() => inflight.delete(symbol)).catch(() => {})
      inflight.set(symbol, p)
    }
    return p
  }

  return {
    async price(symbol) {
      const l = await get(symbol)
      return l ? { priceMinor: l.priceMinor, at: l.at, source: l.source } : fixture.price(symbol)
    },
    async history(symbol, points) {
      const l = await get(symbol)
      return l ? l.history.map((d) => d.minor).slice(-Math.max(0, points)) : fixture.history(symbol, points)
    },
  }
}
