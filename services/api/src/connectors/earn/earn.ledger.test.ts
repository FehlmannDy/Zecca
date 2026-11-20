// Real Earn deposit through the API: Devnet side faked (harness), Testnet + Coston2 live. A fresh treasury from the faucet,
// never the real key store. $10 at the live XRP/USD rate -> ~10.9 XRP into Firelight, the probe's amounts.
// Run: npm run test:ledger -- services/api/src/connectors/earn  (unsandboxed; ~3-5 minutes, Flare takes ~160 s)
import { afterAll, describe, expect, it } from 'vitest'
import { generateWalletSecret } from '@zecca/xrpl-core'
import { makeHarness } from '../../testing/harness'
import type { FakeLedger, FakePool } from '../../testing/fakes'
import { createLiveTestnet } from './live-testnet'
import { createLiveFlare } from './live-flare'
import { createXrpPriceFeed } from './price'
import { mountEarn, registerEarn } from './index'
import { steps } from './repo'

const lines: string[] = []
const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`), error: (m: string) => lines.push(`ERROR ${m}`) }
const h = makeHarness<FakeLedger, FakePool>({ env: { FEATURE_EARN: '1', EARN_MODE: 'live' }, extra: { log } })
h.keystore.setWallet('testnetTreasury', generateWalletSecret())
const testnet = createLiveTestnet({ keystore: h.keystore, log: log.info })
const flare = createLiveFlare()
registerEarn(h.app.core, { sides: { testnet, flare }, price: createXrpPriceFeed({ live: true, log: log.info }), pollMs: 10_000, openTimeoutMs: 12 * 60_000, jobs: false })
mountEarn(h.app, h.app.core)

afterAll(async () => {
  process.stderr.write(`\n[earn ledger log]\n${lines.join('\n')}\n`)
  await testnet.client.close()
})

describe('Earn on XRPL Testnet + Flare Coston2', () => {
  it(
    'one approval: $10 -> XRP -> smart account -> Firelight, position read from Coston2',
    async () => {
      await testnet.topUpTreasury(30_000_000n)
      const ana = await h.signUp('ana')
      h.app.core.db.prepare('UPDATE users SET tier = 1 WHERE id = ?').run(ana.user.id)
      const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
      expect(d.status).toBe(200)
      lines.push(`quote ${JSON.stringify(d.body.quote)}`)
      const s = await h.submit(ana, d.body.prepared)
      expect(s.body.status).toBe('validated')

      const started = Date.now()
      let p: any
      for (;;) {
        p = (await h.json('GET', '/v1/earn/position', { token: ana.token })).body
        if (p.status === 'active' || p.lastFailure || Date.now() - started > 13 * 60_000) break
        await new Promise((r) => setTimeout(r, 5_000))
      }
      const id = d.body.intent.id
      lines.push(`position ${JSON.stringify(p)}`)
      lines.push(`funding ${steps.get(h.app.core, `dep:${id}:fund`)?.hash} core vault payment ${steps.get(h.app.core, `dep:${id}:pay`)?.hash}`)
      lines.push(`seconds from approval to active: ${Math.round((Date.now() - started) / 1000)}`)
      expect(p.status).toBe('active')
      expect(p.valueDrops).toBeGreaterThanOrEqual(d.body.quote.xrpDrops - 1)
      expect(p.depositedDrops).toBe(d.body.quote.xrpDrops)
      expect(p.ledger.smartAccount).toMatch(/^0x[0-9a-fA-F]{40}$/)
    },
    15 * 60_000,
  )
})
