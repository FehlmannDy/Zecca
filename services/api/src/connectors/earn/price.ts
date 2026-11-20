// XRP/USD for the Earn conversion (SPEC §4.7, §11: shown with its time and source, never a made-up live price).
// Live: CoinGecko's public simple-price endpoint, cached a minute; on failure the last good rate, else a dated fixture.
import { parseMicros } from './math'

export type XrpRate = { microUsdPerXrp: number; at: string; source: string }
export interface XrpPriceFeed {
  rate(): Promise<XrpRate>
}

/** Read from CoinGecko on 2026-11-20 at 22:28:51 UTC, while building. Used offline and when the API is down. */
export const FIXTURE_RATE: XrpRate = { microUsdPerXrp: 912_630, at: '2026-11-20T22:28:51.000Z', source: 'Fixture (CoinGecko, 2026-11-20 22:28 UTC)' }

export const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=ripple&vs_currencies=usd&include_last_updated_at=true'

/** Parses the reply from its text, so the decimal price never goes through a float. */
export function parseCoinGecko(text: string): XrpRate | null {
  const usd = /"usd"\s*:\s*([0-9.]+)/.exec(text)?.[1]
  const ts = /"last_updated_at"\s*:\s*(\d+)/.exec(text)?.[1]
  const micro = usd ? parseMicros(usd) : null
  if (!micro || !ts) return null
  return { microUsdPerXrp: micro, at: new Date(Number(ts) * 1000).toISOString(), source: 'CoinGecko' }
}

export function createXrpPriceFeed(o: { live: boolean; fetch?: typeof fetch; now?: () => number; cacheMs?: number; log?: (m: string) => void } = { live: false }): XrpPriceFeed {
  const now = o.now ?? Date.now
  const cacheMs = o.cacheMs ?? 60_000
  let last: { rate: XrpRate; readAt: number } | null = null
  let inflight: Promise<XrpRate> | null = null

  async function readLive(): Promise<XrpRate> {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), 8_000)
    try {
      const res = await (o.fetch ?? fetch)(COINGECKO_URL, { signal: ctl.signal, headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`price API ${res.status}`)
      const r = parseCoinGecko(await res.text())
      if (!r) throw new Error('price API reply not understood')
      last = { rate: r, readAt: now() }
      return r
    } finally {
      clearTimeout(t)
    }
  }

  return {
    async rate() {
      if (!o.live) return FIXTURE_RATE
      if (last && now() - last.readAt < cacheMs) return last.rate
      inflight ??= readLive()
        .catch((e) => {
          o.log?.(`[earn] price feed: ${(e as Error).message}; using ${last ? 'the last good rate' : 'the fixture'}`)
          return last?.rate ?? FIXTURE_RATE
        })
        .finally(() => (inflight = null))
      return inflight
    },
  }
}
