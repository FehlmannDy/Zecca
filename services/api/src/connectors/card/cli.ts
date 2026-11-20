// Card connector CLI (run from zecca/, unsandboxed; prints no secret):
//   node --env-file=.env -r ./scripts/dev/dnsfix.cjs node_modules/tsx/dist/cli.mjs services/api/src/connectors/card/cli.ts enroll [--base https://<tunnel>] [--port 8800]
//   ... cli.ts status
//   ... cli.ts live-check [--port 8810]   a real sandbox purchase approved and one declined through our webhook (mock ledger)
// The tunnel: node node_modules/tsx/dist/cli.mjs scripts/tunnel.ts --port <port>  (gives PUBLIC_WEBHOOK_BASE).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLithicHttp } from './lithic-api'
import { enrollCardWebhook, publicBaseFrom } from './setup'

const ZECCA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')
const argv = process.argv.slice(2)
const cmd = argv[0]

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8')
  } catch {
    return undefined
  }
}

async function main() {
  const lithic = createLithicHttp({ apiKey: process.env.LITHIC_API_KEY, baseUrl: process.env.LITHIC_BASE_URL })
  if (cmd === 'enroll') {
    const base = publicBaseFrom(argv.slice(1), process.env, read, ZECCA)
    if (!base) throw new Error('No public base: pass --base https://<tunnel>, set PUBLIC_WEBHOOK_BASE, or start scripts/tunnel.ts first.')
    await enrollCardWebhook({ lithic, publicBase: base, log: (m) => console.log(m) })
    return
  }
  if (cmd === 'status') {
    const e = (await lithic.asaEnrollment()) as { data?: Array<{ url?: string }> }
    console.log(`ASA endpoint: ${e.data?.[0]?.url ?? 'none enrolled'}`)
    return
  }
  if (cmd === 'live-check') {
    const { liveCheck } = await import('./live-check')
    const p = argv.indexOf('--port')
    await liveCheck({ port: Number(p >= 0 ? argv[p + 1] : 8810), zeccaRoot: ZECCA })
    return
  }
  console.log('usage: cli.ts enroll [--base https://...] [--port 8800] | status | live-check [--port 8810]')
  process.exitCode = 2
}

main().catch((e) => {
  console.error(`card cli: ${(e as Error).message}`)
  process.exitCode = 1
})
