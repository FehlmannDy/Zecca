// Check a Zecca statement against the public ledger, without trusting Zecca.
//
//   node node_modules/tsx/dist/cli.mjs services/api/src/connectors/proofs/verify-cli.ts <statement> [--node wss://...] [--signer r...]
//
// <statement> is a saved JSON file or its URL (GET <api>/v1/disclosures/<id>). --signer pins Zecca's statement address
// (the kycIssuer account) instead of trusting the key the statement carries. On this laptop add -r ./scripts/dev/dnsfix.cjs.
// Exit code 0 when everything checks, 1 otherwise.
import { readFileSync } from 'node:fs'
import xrpl from 'xrpl'
import { formatUsd, Statement } from '@zecca/contracts'
import { checkStatement } from './verify'
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
    console.error('usage: verify-cli.ts <statement.json | statement URL> [--node wss://...] [--signer rAddress]')
    return 2
  }
  const s = Statement.parse(await load(src))
  const network = s.lines[0]?.network ?? 'devnet'
  const reader = xrplReader(new xrpl.Client(arg('--node') ?? PUBLIC_NODES[network]))
  try {
    const r = await checkStatement(s, reader, { expectedSigner: arg('--signer') })
    console.log(`Statement ${s.id} for @${s.holder.handle} (${s.holder.address}), ${s.lines.length} line(s), attestation: ${s.attestation}`)
    console.log(
      r.signature.ok
        ? `Signature: valid, signed by ${r.signature.signerAddress}${r.signerMismatch ? ` (NOT the expected ${arg('--signer')})` : ''}`
        : `Signature: INVALID (${r.signature.reason})`,
    )
    s.lines.forEach((l, k) => {
      const c = r.lines[k]
      console.log(
        `${String(k + 1).padStart(3)}  ${l.date.slice(0, 10)}  ${l.direction === 'in' ? 'in ' : 'out'}  ${formatUsd(l.amountMinor).padStart(12)}  ${l.counterparty.padEnd(24).slice(0, 24)}  ledger: ${c.transactions.padEnd(7)}  amount: ${c.amount}${c.detail && c.amount === 'invalid' ? ` (${c.detail})` : ''}`,
      )
    })
    console.log(r.ok ? 'Result: everything checks.' : 'Result: FAILED.')
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
