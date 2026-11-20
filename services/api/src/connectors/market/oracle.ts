// Prices on the ledger (SPEC §4.9 "to verify"): the oracle account publishes the three metals with one OracleSet
// (per gram, in cents: Scale 2), we read the validated transaction back and serve the price from it. When the
// publish fails, or the price moved since the last one, the screen gets the off-ledger price, and its source says so.
import type { Ledger, MetalSymbol, PriceFeed, UnsignedTx } from '@zecca/contracts'
import { MetalSymbol as MetalSymbolSchema } from '@zecca/contracts'

export const ORACLE_DOCUMENT_ID = 1
const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
const METALS = MetalSymbolSchema.options

export function buildOracleSet(o: { account: string; prices: Partial<Record<MetalSymbol, number>>; lastUpdateTime: number; documentId?: number }): UnsignedTx {
  const series = METALS.filter((s) => o.prices[s] !== undefined).map((s) => {
    const p = o.prices[s]!
    if (!Number.isSafeInteger(p) || p < 1) throw new TypeError(`price of ${s} must be a positive integer, got ${p}`)
    return { PriceData: { BaseAsset: s, QuoteAsset: 'USD', AssetPrice: p, Scale: 2 } }
  })
  if (!series.length) throw new Error('nothing to publish')
  return {
    TransactionType: 'OracleSet',
    Account: o.account,
    OracleDocumentID: o.documentId ?? ORACLE_DOCUMENT_ID,
    Provider: hex('zecca'),
    AssetClass: hex('commodity'),
    LastUpdateTime: o.lastUpdateTime,
    PriceDataSeries: series,
  }
}

/** Cents per gram for each metal in an OracleSet (AssetPrice is a hex UInt64 on the ledger, a number in our own JSON). */
export function readOracleSet(tx: Record<string, unknown>): Partial<Record<MetalSymbol, number>> {
  const out: Partial<Record<MetalSymbol, number>> = {}
  for (const e of (tx.PriceDataSeries as Array<{ PriceData?: Record<string, unknown> }> | undefined) ?? []) {
    const d = e.PriceData
    if (!d || d.QuoteAsset !== 'USD' || !METALS.includes(d.BaseAsset as MetalSymbol)) continue
    const raw = d.AssetPrice
    const value = typeof raw === 'string' && /^[0-9A-Fa-f]{1,16}$/.test(raw) ? BigInt('0x' + raw) : typeof raw === 'number' && Number.isSafeInteger(raw) ? BigInt(raw) : null
    const scale = typeof d.Scale === 'number' ? d.Scale : 0
    if (value === null || scale < 0 || scale > 10) continue
    const minor = scale <= 2 ? value * 10n ** BigInt(2 - scale) : (value * 2n + 10n ** BigInt(scale - 2)) / (2n * 10n ** BigInt(scale - 2))
    out[d.BaseAsset as MetalSymbol] = Number(minor)
  }
  return out
}

export type Published = { hash: string; publishedAt: string; prices: Partial<Record<MetalSymbol, number>> }

export type OracleFeed = PriceFeed & {
  /** Publish the current prices now and read them back. Throws when the ledger refuses or the read-back differs. */
  publish(): Promise<Published>
  lastPublished(): Published | null
}

export function createOracleFeed(o: {
  inner: PriceFeed
  ledger: Ledger
  oracleAddress: string
  now?: () => number
  /** At most one publish per interval (default 5 minutes). */
  minIntervalMs?: number
  log?: (m: string) => void
}): OracleFeed {
  const now = o.now ?? Date.now
  const interval = o.minIntervalMs ?? 5 * 60_000
  const log = o.log ?? (() => {})
  let last: Published | null = null
  let lastAttempt = -Infinity
  let running: Promise<Published> | null = null

  async function publishNow(): Promise<Published> {
    lastAttempt = now()
    const prices: Partial<Record<MetalSymbol, number>> = {}
    for (const s of METALS) prices[s] = (await o.inner.price(s)).priceMinor
    // LastUpdateTime must grow with every update of the same oracle document.
    const lastSecs = last ? Math.floor(Date.parse(last.publishedAt) / 1000) : 0
    const tx = buildOracleSet({ account: o.oracleAddress, prices, lastUpdateTime: Math.max(Math.floor(now() / 1000), lastSecs + 1) })
    const r = await o.ledger.submitAs('oracle', tx)
    if (!r.validated || r.engineResult !== 'tesSUCCESS') throw new Error(`OracleSet ${r.engineResult} ${r.hash}`)
    const back = await o.ledger.txByHash(r.hash)
    if (!back?.validated) throw new Error(`OracleSet ${r.hash} not found on the ledger`)
    const read = readOracleSet(back.tx)
    for (const s of METALS) if (read[s] !== prices[s]) throw new Error(`oracle read-back of ${s} is ${read[s]}, published ${prices[s]}`)
    last = { hash: r.hash, publishedAt: new Date(Number(tx.LastUpdateTime) * 1000).toISOString(), prices: read }
    log(`[market] prices published on the ledger oracle (${r.hash})`)
    return last
  }

  function publish(): Promise<Published> {
    running ??= publishNow()
      .catch((e: Error) => {
        log(`[market] oracle publish failed, serving off-ledger prices: ${e.message}`)
        throw e
      })
      .finally(() => (running = null))
    return running
  }

  function kick(): void {
    if (running || now() - lastAttempt < interval) return
    publish().catch(() => {})
  }

  return {
    publish,
    lastPublished: () => last,
    async price(symbol) {
      const p = await o.inner.price(symbol)
      kick()
      if (last?.prices[symbol] === p.priceMinor) return { priceMinor: last.prices[symbol]!, at: p.at, source: `${p.source}, read from the XRPL oracle` }
      return p
    },
    history: (symbol, points) => o.inner.history(symbol, points),
  }
}
