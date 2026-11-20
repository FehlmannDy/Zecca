// The three metals (SPEC §4.9): ordinary MPTs issued by the market issuer, 1 unit = 1 milligram (AssetScale 0).
// Their issuance ids live in key store meta ('metal:XAU', 'metal:XAG', 'metal:XPD'), written by
// scripts/bootstrap-market.ts on Devnet, or by ensureMetalIssuances on the mock ledger at start-up.
import xrpl from 'xrpl'
import type { KeyStore, Ledger, MetalSymbol } from '@zecca/contracts'

export const METALS: ReadonlyArray<{ symbol: MetalSymbol; name: string; noun: string }> = [
  { symbol: 'XAU', name: 'Gold', noun: 'gold' },
  { symbol: 'XAG', name: 'Silver', noun: 'silver' },
  { symbol: 'XPD', name: 'Palladium', noun: 'palladium' },
]
export const metalOf = (symbol: MetalSymbol) => METALS.find((m) => m.symbol === symbol)!
export const metaKey = (symbol: MetalSymbol) => `metal:${symbol}`

export function metalIssuanceId(keystore: KeyStore, symbol: MetalSymbol): string | undefined {
  return keystore.getMeta(metaKey(symbol))
}

/** XLS-89 metadata, hex. */
export function metalMetadataHex(symbol: MetalSymbol): string {
  const m = metalOf(symbol)
  const json = { ticker: symbol, name: `${m.name} (1 unit = 1 mg)`, desc: `${m.name} held for Zecca customers, in milligrams.`, asset_class: 'rwa', asset_subclass: 'commodity', issuer_name: 'Zecca' }
  return Buffer.from(JSON.stringify(json), 'utf8').toString('hex').toUpperCase()
}

/** The ticker in an issuance's XLS-89 metadata (hex JSON), or undefined. */
export function tickerOfMetadata(hex: unknown): string | undefined {
  if (typeof hex !== 'string' || !/^([0-9A-Fa-f]{2})+$/.test(hex)) return undefined
  try {
    const j = JSON.parse(Buffer.from(hex, 'hex').toString('utf8')) as { ticker?: unknown; t?: unknown }
    const t = j.ticker ?? j.t
    return typeof t === 'string' ? t : undefined
  } catch {
    return undefined
  }
}

export function metalIssuanceCreate(account: string, symbol: MetalSymbol): Record<string, unknown> & { TransactionType: string; Account: string } {
  return { TransactionType: 'MPTokenIssuanceCreate', Account: account, AssetScale: 0, Flags: 0, MPTokenMetadata: metalMetadataHex(symbol) }
}

/** MPTokenIssuanceID = the creating transaction's Sequence (4 bytes, big-endian) + the issuer's AccountID. */
export function issuanceIdFrom(sequence: number, issuer: string): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 0xffffffff) throw new TypeError(`bad sequence ${sequence}`)
  return (sequence.toString(16).padStart(8, '0') + Buffer.from(xrpl.decodeAccountID(issuer)).toString('hex')).toUpperCase()
}

/**
 * Creates the missing metal issuances through the Ledger interface and stores their ids (used on the mock ledger,
 * whose key store starts empty on every run). Devnet uses scripts/bootstrap-market.ts, which also checks the ledger.
 */
export async function ensureMetalIssuances(ledger: Ledger, keystore: KeyStore, log: (m: string) => void = () => {}): Promise<MetalSymbol[]> {
  const created: MetalSymbol[] = []
  if (!keystore.hasWallet('marketIssuer')) return created
  const issuer = keystore.getWallet('marketIssuer').address
  for (const { symbol } of METALS) {
    if (metalIssuanceId(keystore, symbol)) continue
    const r = await ledger.submitAs('marketIssuer', metalIssuanceCreate(issuer, symbol))
    if (!r.validated || r.engineResult !== 'tesSUCCESS') throw new Error(`metal ${symbol} issuance: ${r.engineResult}`)
    let id = typeof r.meta?.mpt_issuance_id === 'string' ? r.meta.mpt_issuance_id : undefined
    if (!id) {
      const seq = (await ledger.txByHash(r.hash))?.tx.Sequence
      if (typeof seq !== 'number') throw new Error(`metal ${symbol} issuance ${r.hash}: no issuance id`)
      id = issuanceIdFrom(seq, issuer)
    }
    keystore.setMeta(metaKey(symbol), id.toUpperCase())
    created.push(symbol)
    log(`[market] ${symbol} issuance ${id}`)
  }
  return created
}
