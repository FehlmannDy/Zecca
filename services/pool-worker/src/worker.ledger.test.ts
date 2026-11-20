// Devnet: the pool worker over the live ledger. A fresh user signs up (welcome credit, MergeInbox delegated to the relayer),
// deposits to the pool, the worker verifies it, pays it back and the relayer merges the user's inbox.
// Run unsandboxed from zecca/: node --env-file=.env -r ./scripts/dev/dnsfix.cjs ./node_modules/vitest/vitest.mjs run --project ledger services/pool-worker
import { describe, expect, it } from 'vitest'
import type { PoolEvent } from '@zecca/contracts'
import { createMemoryKeyStore, openKeyStoreFromEnv } from '@zecca/keystore'
import { createLiveLedger } from '@zecca/xrpl-core'
import { mockRawSigner } from '@zecca/xrpl-core/signer'
import { createMemoryPoolStore, createPoolWorker } from './index'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(250)
  }
}

describe.skipIf(!process.env.KEYSTORE_PASSPHRASE)('pool worker on Devnet', () => {
  it('deposit -> received -> payout -> paidOut -> merge inbox via the relayer', async () => {
    // In-memory copy of the product key store: the test user's keys are never written to the file.
    const keystore = createMemoryKeyStore({ initial: openKeyStoreFromEnv(process.env).snapshot() })
    const ledger = createLiveLedger({ network: 'devnet', keystore })
    const logs: string[] = []
    const worker = createPoolWorker({ ledger, keystore, store: createMemoryPoolStore(), log: (m) => logs.push(m) })
    const events: PoolEvent[] = []
    for (const t of ['received', 'paidOut', 'failed'] as const) worker.on(t, (e) => events.push(e))
    try {
      const pool = keystore.getWallet('pool').address
      // The relayer comes from scripts/bootstrap-ledger; without it the merge step is skipped and the payout stays in the inbox.
      const relayer = keystore.hasWallet('relayer') ? keystore.getWallet('relayer').address : undefined
      const user = mockRawSigner()
      await ledger.ensureAccount(user.address)
      keystore.createUserElGamal(user.address)
      const userKey = keystore.getElGamal({ user: user.address })
      const onboarding = await ledger.buildOnboarding({ address: user.address, publicKey: user.publicKey, holderKey: userKey, welcomeCreditMinor: 200, delegateMergeTo: relayer })
      expect((await ledger.submitUserSigned((await user.sign(onboarding)).tx_blob)).engineResult).toBe('tesSUCCESS')

      await worker.start()
      const send = await ledger.buildSend({ from: user.address, to: pool, amountMinor: 100, senderKey: userKey, sponsored: true, publicKey: user.publicKey })
      const dep = await ledger.submitUserSigned((await user.sign(send)).tx_blob)
      expect(dep.engineResult).toBe('tesSUCCESS')
      worker.expectDeposit({ intentId: 'ledger_test', txHash: dep.hash, from: user.address, amountMinor: 100 })
      await waitFor(() => events.length > 0, 60_000)
      expect(events[0]).toEqual({ type: 'received', intentId: 'ledger_test', txHash: dep.hash, from: user.address, amountMinor: 100 })

      const out = await worker.payout({ intentId: 'ledger_test', to: user.address, amountMinor: 100 })
      expect(events[1]).toEqual({ type: 'paidOut', intentId: 'ledger_test', txHash: out.hash, to: user.address, amountMinor: 100 })
      expect((await worker.payout({ intentId: 'ledger_test', to: user.address, amountMinor: 100 })).hash).toBe(out.hash)

      if (relayer) {
        await worker.mergeInboxFor(user.address)
        expect(await ledger.confidentialBalance(user.address, userKey)).toEqual({ spendableMinor: 200, inboxMinor: 0 })
      } else {
        console.log('[pool ledger test] no relayer wallet in the key store: merge step skipped')
        expect(await ledger.confidentialBalance(user.address, userKey)).toEqual({ spendableMinor: 100, inboxMinor: 100 })
      }
      expect(events.filter((e) => e.type === 'failed')).toEqual([])
    } finally {
      await worker.stop()
      await ledger.close()
    }
  })
})
