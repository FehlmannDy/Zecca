// Creates, idempotently, the three metal MPT issuances of the market (SPEC §4.9) on Devnet from the key store's
// marketIssuer wallet (created and funded by scripts/bootstrap-ledger.ts), and stores their ids in key store meta
// ('metal:XAU', 'metal:XAG', 'metal:XPD'). 1 unit = 1 milligram (AssetScale 0). Checks the key store, then the ledger
// (an issuance whose metadata ticker matches is reused), so a second run creates nothing. Prints ids and addresses only.
// Run from zecca/ (unsandboxed):
//   node -r ./scripts/dev/dnsfix.cjs node_modules/tsx/dist/cli.mjs scripts/bootstrap-market.ts
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { KeyStore, MetalSymbol } from '@zecca/contracts'
import { openKeyStoreFromEnv } from '@zecca/keystore'
import { createClient, fetchIssuance, fillTx, walletFrom, type XrplClient } from '@zecca/xrpl-core'
import { METALS, issuanceIdFrom, metaKey, metalIssuanceCreate, tickerOfMetadata } from '../services/api/src/connectors/market/metals'

export type BootstrapMarketOptions = { keystore: KeyStore; devnet?: XrplClient; log?: (line: string) => void }

const notFound = (e: unknown) => ['entryNotFound', 'objectNotFound'].includes(String((e as { data?: { error?: string } })?.data?.error))

export async function bootstrapMarket(opts: BootstrapMarketOptions): Promise<{ created: MetalSymbol[]; ids: Record<MetalSymbol, string> }> {
  const { keystore } = opts
  const log = opts.log ?? console.log
  const devnet = opts.devnet ?? createClient('devnet')
  if (!keystore.hasWallet('marketIssuer')) throw new Error('no marketIssuer wallet in the key store: run scripts/bootstrap-ledger.ts first')
  const wallet = walletFrom(keystore.getWallet('marketIssuer'))
  const issuer = wallet.classicAddress
  const created: MetalSymbol[] = []
  const ids = {} as Record<MetalSymbol, string>
  try {
    if (!(await devnet.accountInfo(issuer))) throw new Error(`marketIssuer ${issuer} is not on Devnet: run scripts/bootstrap-ledger.ts first`)
    let existing: Array<Record<string, unknown>> | null = null
    const onLedger = async () =>
      (existing ??= ((await devnet.request({ command: 'account_objects', account: issuer, type: 'mpt_issuance', ledger_index: 'validated', limit: 400 })).result.account_objects ?? []) as Array<
        Record<string, unknown>
      >)

    for (const { symbol } of METALS) {
      let id = keystore.getMeta(metaKey(symbol))
      if (id) {
        const node = await fetchIssuance(devnet, id).catch((e) => {
          if (notFound(e)) return null
          throw e
        })
        if (node && node.Issuer !== issuer) throw new Error(`metal ${symbol} issuance ${id} is not issued by the key store marketIssuer ${issuer}`)
        if (!node) id = undefined
      }
      if (!id) {
        const found = (await onLedger()).find((n) => tickerOfMetadata(n.MPTokenMetadata) === symbol)
        if (found) id = String(found.mpt_issuance_id ?? issuanceIdFrom(Number(found.Sequence), issuer))
      }
      if (!id) {
        const filled = await fillTx(devnet, metalIssuanceCreate(issuer, symbol), {})
        const r = await devnet.submitAndWait(wallet.sign(filled as never).tx_blob)
        if (r.engineResult !== 'tesSUCCESS') throw new Error(`metal ${symbol} issuance: ${r.engineResult} ${r.hash}`)
        id = String((r.meta as Record<string, unknown> | undefined)?.mpt_issuance_id ?? issuanceIdFrom(Number(filled.Sequence), issuer))
        created.push(symbol)
        log(`  created metal ${symbol}`)
      }
      id = id.toUpperCase()
      if (keystore.getMeta(metaKey(symbol)) !== id) keystore.setMeta(metaKey(symbol), id)
      ids[symbol] = id
    }
    log(`${'marketIssuer'.padEnd(16)} ${issuer}`)
    for (const { symbol } of METALS) log(`${metaKey(symbol).padEnd(16)} ${ids[symbol]}`)
    log(created.length ? `created ${created.length} metal issuance(s)` : 'nothing to create')
    return { created, ids }
  } finally {
    if (!opts.devnet) await devnet.close()
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) {
  const envFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env')
  if (existsSync(envFile)) process.loadEnvFile(envFile)
  bootstrapMarket({ keystore: openKeyStoreFromEnv(process.env) }).catch((e) => {
    console.error((e as Error).message)
    process.exit(1)
  })
}
