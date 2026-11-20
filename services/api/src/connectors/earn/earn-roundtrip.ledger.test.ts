// The Earn withdrawal on Testnet + Coston2, with its state kept in .data/earn-ledger/ (gitignored; Testnet-only keys, in a
// key store file encrypted with KEYSTORE_PASSPHRASE). Firelight pays out after its 4 h period ends, so this takes two runs
// of the same command:
//   run 1: $10 into Earn, then the withdrawal request (Firelight.redeem); prints when it becomes claimable (4 to 8 h)
//   run 2 (after that): claim, redeem the FXRP to XRP (agent payout on Testnet), dollars credited through the pool
// npm run test:ledger -- services/api/src/connectors/earn/earn-roundtrip   (unsandboxed)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { createFileKeyStore } from '@zecca/keystore'
import { generateWalletSecret } from '@zecca/xrpl-core'
import { makeHarness } from '../../testing/harness'
import { FAKE_CMPT, type FakeLedger, type FakePool } from '../../testing/fakes'
import { createLiveTestnet } from './live-testnet'
import { createLiveFlare } from './live-flare'
import { createXrpPriceFeed } from './price'
import { earnOf, mountEarn, registerEarn } from './index'
import { steps, withdrawals } from './repo'

const DIR = '.data/earn-ledger'
const RUN = `${DIR}/run.json`
const passphrase = process.env.KEYSTORE_PASSPHRASE

describe.skipIf(!passphrase)('Earn withdrawal round trip (Testnet + Coston2, two runs)', () => {
  mkdirSync(DIR, { recursive: true })
  let n = 0
  const keystore = createFileKeyStore({
    path: `${DIR}/keystore.enc`,
    passphrase: passphrase!,
    // The Devnet side is faked here: trivial ElGamal keys, like the unit tests.
    generateElGamal: () => {
      const h = (Date.now() * 1000 + ++n).toString(16).padStart(64, '0').toUpperCase()
      return { publicKey: '02' + h, privateKey: h }
    },
  })
  if (!keystore.hasWallet('pool')) {
    for (const role of ['sponsor', 'issuer', 'pool', 'relayer', 'demoShop', 'testnetTreasury'] as const) keystore.setWallet(role, generateWalletSecret())
    keystore.setElGamal('pool', { publicKey: '03' + 'A'.repeat(64), privateKey: 'B'.repeat(64) })
    keystore.setElGamal('issuer', { publicKey: '03' + 'C'.repeat(64), privateKey: 'D'.repeat(64) })
    keystore.setMeta('cmptIssuanceId', FAKE_CMPT)
  }
  const lines: string[] = []
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(`WARN ${m}`), error: (m: string) => lines.push(`ERROR ${m}`) }
  const h = makeHarness<FakeLedger, FakePool>({ keystore, env: { FEATURE_EARN: '1', EARN_MODE: 'live' }, extra: { log, db: `${DIR}/api.sqlite` } })
  const testnet = createLiveTestnet({ keystore, log: log.info })
  const flare = createLiveFlare()
  registerEarn(h.app.core, { sides: { testnet, flare }, price: createXrpPriceFeed({ live: true, log: log.info }), pollMs: 10_000, openTimeoutMs: 12 * 60_000, payoutTimeoutMs: 10 * 60_000, jobs: false })
  mountEarn(h.app, h.app.core)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  afterAll(async () => {
    process.stderr.write(`\n[earn round trip log]\n${lines.join('\n')}\n`)
    await testnet.client.close()
  })

  it(
    'deposit + withdrawal request now; claim, redeem and dollar credit once the Firelight period has ended',
    async () => {
      const core = h.app.core
      if (!existsSync(RUN)) {
        await testnet.topUpTreasury(30_000_000n)
        const ana = await h.signUp(`ana${Date.now().toString(36).slice(-5)}`)
        core.db.prepare('UPDATE users SET tier = 1 WHERE id = ?').run(ana.user.id)
        const d = await h.json('POST', '/v1/earn/deposits', { token: ana.token, body: { amountMinor: 1000 } })
        expect(d.status).toBe(200)
        expect((await h.submit(ana, d.body.prepared)).body.status).toBe('validated')
        let p: any
        for (const t0 = Date.now(); Date.now() - t0 < 12 * 60_000; await sleep(5_000)) {
          p = (await h.json('GET', '/v1/earn/position', { token: ana.token })).body
          if (p.status === 'active' || p.lastFailure) break
        }
        expect(p.status).toBe('active')
        lines.push(`deposit ${d.body.intent.id}: fund ${steps.get(core, `dep:${d.body.intent.id}:fund`)?.hash} pay ${p.ledger.lastPaymentHash} smart account ${p.ledger.smartAccount}`)

        const w = await h.json('POST', '/v1/earn/withdrawals', { token: ana.token, body: { amountDrops: p.valueDrops } })
        expect(w.status).toBe(200)
        const row = withdrawals.open(core, ana.user.id)!
        writeFileSync(RUN, JSON.stringify({ token: ana.token, userId: ana.user.id, depositId: d.body.intent.id, withdrawalId: row.id, claimableAt: w.body.claimableAt }, null, 1), { mode: 0o600 })
        for (const t0 = Date.now(); Date.now() - t0 < 12 * 60_000 && withdrawals.get(core, row.id)!.status === 'requesting'; ) await sleep(5_000)
        const after = withdrawals.get(core, row.id)!
        lines.push(`withdrawal ${row.id}: ${after.status}, request ${steps.get(core, `wd:${row.id}:request:pay`)?.hash}, period ${after.period}, owed ${after.owedDrops} drops, claimable after ${w.body.claimableAt}`)
        expect(after.status).toBe('requested')
        return
      }

      const run = JSON.parse(readFileSync(RUN, 'utf8')) as { token: string; userId: string; withdrawalId: string; claimableAt: string }
      const before = withdrawals.get(core, run.withdrawalId)!
      if (before.status === 'requested' && (await flare.currentPeriod()) <= before.period!) {
        lines.push(`withdrawal ${run.withdrawalId} not claimable yet (period ${before.period} ends before ${run.claimableAt}); run this again after that`)
        return
      }
      const balance0 = (await h.json('GET', '/v1/balance', { token: run.token })).body
      for (const t0 = Date.now(); Date.now() - t0 < 20 * 60_000; await sleep(10_000)) {
        await earnOf(core).tick({ force: true })
        const s = withdrawals.get(core, run.withdrawalId)!.status
        if (s === 'credited' || s === 'failed') break
      }
      await h.settle()
      const w = withdrawals.get(core, run.withdrawalId)!
      const id = run.withdrawalId
      lines.push(
        `withdrawal ${id}: ${w.status}; claim ${steps.get(core, `wd:${id}:claim:pay`)?.hash}, redeem ${steps.get(core, `wd:${id}:redeem:pay`)?.hash}; ` +
          `${w.redeemedDrops} drops (${w.redeemedDrops ? xrpl.dropsToXrp(String(w.redeemedDrops)) : 0} XRP) back, fee ${w.feeDrops} drops, credit ${w.creditMinor} cents (${w.creditIntentId})`,
      )
      expect(w.status).toBe('credited')
      const balance1 = (await h.json('GET', '/v1/balance', { token: run.token })).body
      lines.push(`balance ${JSON.stringify(balance0)} -> ${JSON.stringify(balance1)}`)
      expect(balance1.availableMinor + balance1.pendingMinor).toBe(balance0.availableMinor + balance0.pendingMinor + w.creditMinor!)
    },
    25 * 60_000,
  )
})
