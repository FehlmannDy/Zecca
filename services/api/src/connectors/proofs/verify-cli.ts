// Check a Zecca statement against the public ledger, without trusting the statement.
//
//   node node_modules/tsx/dist/cli.mjs services/api/src/connectors/proofs/verify-cli.ts <statement>
//        [--api https://api...] [--signer r...] [--pool r...] [--issuance <hex>] [--node wss://...]
//
// <statement> is a saved JSON file or its URL (GET <api>/v1/disclosures/<id>). What the check trusts (the anchors):
// Zecca's pool address and issuance id, read from <api>/v1/config (the statement URL's origin, or --api), and Zecca's
// statement signer address (--signer, or addresses.statementSigner in that config once it is published). Flags win over
// the config. Without a pinned signer the result is never "everything checks": any key can sign a statement.
// On this laptop add -r ./scripts/dev/dnsfix.cjs. Exit code 0 when everything checks, 1 otherwise, 2 on bad usage.
import { readFileSync } from 'node:fs'
import xrpl from 'xrpl'
import { formatUsd, Statement } from '@zecca/contracts'
import { anchorsFrom, checkStatement } from './verify'
import { PUBLIC_NODES, xrplReader } from './ledger-reader'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

async function load(src: string): Promise<unknown> {
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`${src} answered ${res.status}`)
    return res.json()
  }
  return JSON.parse(readFileSync(src, 'utf8'))
}

async function main(): Promise<number> {
  const src = process.argv[2]
  if (!src || src.startsWith('--')) {
    console.error('usage: verify-cli.ts <statement.json | statement URL> [--api https://...] [--signer rAddress] [--pool rAddress] [--issuance hex] [--node wss://...]')
    return 2
  }
  const s = Statement.parse(await load(src))

  const api = arg('--api') ?? (/^https?:\/\//.test(src) ? new URL(src).origin : undefined)
  let config: unknown
  if (api) {
    try {
      config = await load(`${api.replace(/\/+$/, '')}/v1/config`)
    } catch (e) {
      console.error(`Could not read ${api}/v1/config: ${(e as Error).message}`)
    }
  }
  const pinned = { signer: arg('--signer'), pool: arg('--pool'), issuanceId: arg('--issuance') }
  const anchors = anchorsFrom(config, Object.fromEntries(Object.entries(pinned).filter(([, v]) => v)))
  if (!anchors.pool || !anchors.issuanceId) {
    console.error("Zecca's pool address and issuance id are needed: pass --api <Zecca API origin>, or --pool and --issuance.")
    return 2
  }
  const from = (k: keyof typeof pinned) => (pinned[k] ? 'pinned by hand' : `from ${api}/v1/config`)
  console.log(`Trusting: pool ${anchors.pool} (${from('pool')}), issuance ${anchors.issuanceId} (${from('issuanceId')}), signer ${anchors.signer ? `${anchors.signer} (${from('signer')})` : 'NOT PINNED'}`)

  const network = s.lines[0]?.network ?? 'devnet'
  const reader = xrplReader(new xrpl.Client(arg('--node') ?? PUBLIC_NODES[network]))
  try {
    const r = await checkStatement(s, reader, { pool: anchors.pool, issuanceId: anchors.issuanceId, ...(anchors.signer ? { signer: anchors.signer } : {}) })
    console.log(`Statement ${s.id} for @${s.holder.handle} (${s.holder.address}), ${s.lines.length} line(s), attestation: ${s.attestation}`)
    console.log(
      !r.signature.ok
        ? `Signature: INVALID (${r.signature.reason})`
        : `Signature: valid, signed by ${r.signature.signerAddress}${r.signer === 'mismatch' ? ` (NOT the expected ${anchors.signer})` : r.signer === 'unpinned' ? ' (not compared with any known signer)' : ''}`,
    )
    s.lines.forEach((l, k) => {
      const c = r.lines[k]
      console.log(
        `${String(k + 1).padStart(3)}  ${l.date.slice(0, 10)}  ${l.direction === 'in' ? 'in ' : 'out'}  ${formatUsd(l.amountMinor).padStart(12)}  ${l.counterparty.padEnd(24).slice(0, 24)}  ledger: ${c.transactions.padEnd(7)}  amount: ${c.amount}${c.detail && c.amount === 'invalid' ? ` (${c.detail})` : ''}`,
      )
    })
    console.log(
      r.ok
        ? 'Result: everything checks.'
        : r.signer === 'unpinned' && r.signature.ok && r.lines.every((l) => l.transactions === 'ok' && l.amount !== 'invalid')
          ? "Result: NOT CONFIRMED. Nothing pins who signed it: pass --signer <Zecca's statement address>."
          : 'Result: FAILED.',
    )
    return r.ok ? 0 : 1
  } finally {
    await reader.close()
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`Could not check the statement: ${(e as Error).message}`)
    process.exit(1)
  },
)
