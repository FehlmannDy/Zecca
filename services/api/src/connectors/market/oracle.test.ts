import { describe, expect, it } from 'vitest'
import type { Ledger, LedgerTxEvent, PriceFeed, UnsignedTx, WalletRole } from '@zecca/contracts'
import { ORACLE_DOCUMENT_ID, buildOracleSet, createOracleFeed, readOracleSet } from './oracle'

const ORACLE = 'rOracleAccount11111111111111111'

/** Records submitAs and gives the tx back on txByHash with AssetPrice as hex, like rippled. */
function recordingLedger(result = 'tesSUCCESS') {
  const txs = new Map<string, Record<string, unknown>>()
  const sent: Array<{ role: WalletRole; tx: UnsignedTx }> = []
  let n = 0
  const ledger = {
    async submitAs(role: WalletRole, tx: UnsignedTx) {
      sent.push({ role, tx })
      const hash = (++n).toString(16).padStart(64, '0').toUpperCase()
      const series = (tx.PriceDataSeries as Array<{ PriceData: Record<string, unknown> }>).map((p) => ({
        PriceData: { ...p.PriceData, AssetPrice: Number(p.PriceData.AssetPrice).toString(16) },
      }))
      txs.set(hash, { ...tx, PriceDataSeries: series })
      return { validated: result.startsWith('tes') || result.startsWith('tec'), engineResult: result, hash }
    },
    async txByHash(hash: string): Promise<LedgerTxEvent | null> {
      const tx = txs.get(hash)
      return tx ? { hash, ledgerIndex: 1, validated: true, engineResult: 'tesSUCCESS', tx } : null
    },
  }
  return { ledger: ledger as unknown as Ledger, sent }
}

const inner = (prices: Record<string, number>): PriceFeed => ({
  async price(s) {
    return { priceMinor: prices[s], at: '2026-11-20T21:59:57.000Z', source: 'COMEX via Yahoo Finance' }
  },
  async history() {
    return [1, 2]
  },
})

const flush = () => new Promise((r) => setTimeout(r, 5))

describe('prices on the ledger (OracleSet from the oracle account)', () => {
  it('builds one OracleSet with the three metals per gram in cents (Scale 2)', () => {
    const tx = buildOracleSet({ account: ORACLE, prices: { XAU: 11378, XAG: 132, XPD: 2871 }, lastUpdateTime: 1795212000 })
    expect(tx).toEqual({
      TransactionType: 'OracleSet',
      Account: ORACLE,
      OracleDocumentID: ORACLE_DOCUMENT_ID,
      Provider: Buffer.from('zecca').toString('hex').toUpperCase(),
      AssetClass: Buffer.from('commodity').toString('hex').toUpperCase(),
      LastUpdateTime: 1795212000,
      PriceDataSeries: [
        { PriceData: { BaseAsset: 'XAU', QuoteAsset: 'USD', AssetPrice: 11378, Scale: 2 } },
        { PriceData: { BaseAsset: 'XAG', QuoteAsset: 'USD', AssetPrice: 132, Scale: 2 } },
        { PriceData: { BaseAsset: 'XPD', QuoteAsset: 'USD', AssetPrice: 2871, Scale: 2 } },
      ],
    })
  })

  it('reads prices back from a validated OracleSet (hex AssetPrice, any scale)', () => {
    expect(
      readOracleSet({
        PriceDataSeries: [
          { PriceData: { BaseAsset: 'XAU', QuoteAsset: 'USD', AssetPrice: '2C72', Scale: 2 } },
          { PriceData: { BaseAsset: 'XAG', QuoteAsset: 'USD', AssetPrice: '84', Scale: 2 } },
          { PriceData: { BaseAsset: 'XPD', QuoteAsset: 'USD', AssetPrice: 28710, Scale: 3 } },
          { PriceData: { BaseAsset: 'BTC', QuoteAsset: 'USD', AssetPrice: '1', Scale: 0 } },
        ],
      }),
    ).toEqual({ XAU: 11378, XAG: 132, XPD: 2871 })
  })

  it('publishes, reads back, and then serves the price from the ledger with its source', async () => {
    const { ledger, sent } = recordingLedger()
    let now = Date.parse('2026-11-20T23:00:00Z')
    const feed = createOracleFeed({ inner: inner({ XAU: 11378, XAG: 132, XPD: 2871 }), ledger, oracleAddress: ORACLE, now: () => now })
    expect((await feed.price('XAU')).source).toBe('COMEX via Yahoo Finance') // not published yet
    await flush() // the first read starts a publish in the background
    expect(sent).toHaveLength(1)
    expect(sent[0].role).toBe('oracle')
    expect(feed.lastPublished()).toMatchObject({ prices: { XAU: 11378, XAG: 132, XPD: 2871 } })
    expect(await feed.price('XAU')).toEqual({ priceMinor: 11378, at: '2026-11-20T21:59:57.000Z', source: 'COMEX via Yahoo Finance, read from the XRPL oracle' })
    // no new publish inside the interval
    await feed.price('XAG')
    await flush()
    expect(sent).toHaveLength(1)
    now += 6 * 60_000
    await feed.price('XAG')
    await flush()
    expect(sent).toHaveLength(2)
    expect((sent[1].tx.LastUpdateTime as number) > (sent[0].tx.LastUpdateTime as number)).toBe(true)
  })

  it('falls back to the off-ledger price when the publish fails, and says so in the log', async () => {
    const { ledger } = recordingLedger('tecINSUFFICIENT_RESERVE')
    const logs: string[] = []
    const feed = createOracleFeed({ inner: inner({ XAU: 11378, XAG: 132, XPD: 2871 }), ledger, oracleAddress: ORACLE, log: (m) => logs.push(m) })
    await expect(feed.publish()).rejects.toThrow(/tecINSUFFICIENT_RESERVE/)
    expect((await feed.price('XAU')).source).toBe('COMEX via Yahoo Finance')
    await flush()
    expect(logs.join('\n')).toMatch(/oracle/)
  })

  it('a price that moved since the last publish is served off-ledger until it is published again', async () => {
    const { ledger } = recordingLedger()
    const prices = { XAU: 11378, XAG: 132, XPD: 2871 }
    const feed = createOracleFeed({ inner: inner(prices), ledger, oracleAddress: ORACLE })
    await feed.publish()
    prices.XAU = 11400
    expect(await feed.price('XAU')).toMatchObject({ priceMinor: 11400, source: 'COMEX via Yahoo Finance' })
  })
})
