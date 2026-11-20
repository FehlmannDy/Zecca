// Devnet: the pool worker over the live ledger. A fresh user signs up (welcome credit, MergeInbox delegated to the relayer),
// deposits to the pool, the worker verifies it and pays it back, the relayer merges the user's inbox, and a top-up is minted into the pool.
// Run unsandboxed from zecca/: node --env-file=.env -r ./scripts/dev/dnsfix.cjs ./node_modules/vitest/vitest.mjs run --project ledger services/pool-worker
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElGamalKeyPair, KeyStore, Ledger, PoolEvent, PoolWorker } from '@zecca/contracts'
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

const ON = Boolean(process.env.KEYSTORE_PASSPHRASE)
// The relayer comes from scripts/bootstrap-ledger; without it the merge case is reported as skipped.
const HAS_RELAYER = ON && openKeyStoreFromEnv(process.env).hasWallet('relayer')

describe.skipIf(!ON)('pool worker on Devnet', () => {
  let keystore: KeyStore
  let ledger: Ledger
  let worker: PoolWorker
  let user: ReturnType<typeof mockRawSigner>
  let userKey: ElGamalKeyPair
  const events: PoolEvent[] = []

  beforeAll(async () => {
    // In-memory copy of the product key store: the test user's keys are never written to the file.
    keystore = createMemoryKeyStore({ initial: openKeyStoreFromEnv(process.env).snapshot() })
    ledger = createLiveLedger({ network: 'devnet', keystore })
    worker = createPoolWorker({ ledger, keystore, store: createMemoryPoolStore(), log: () => {} })
    for (const t of ['received', 'paidOut', 'failed'] as const) worker.on(t, (e) => events.push(e))
    user = mockRawSigner()
    await ledger.ensureAccount(user.address)
    keystore.createUserElGamal(user.address)
    userKey = keystore.getElGamal({ user: user.address })
    const relayer = HAS_RELAYER ? keystore.getWallet('relayer').address : undefined
    const onboarding = await ledger.buildOnboarding({ address: user.address, publicKey: user.publicKey, holderKey: userKey, welcomeCreditMinor: 200, delegateMergeTo: relayer })
    expect((await ledger.submitUserSigned((await user.sign(onboarding)).tx_blob)).engineResult).toBe('tesSUCCESS')
    await worker.start()
  })

  afterAll(async () => {
    await worker?.stop()
    await ledger?.close()
  })

  it('deposit -> received -> payout -> paidOut, once per intent', async () => {
    const pool = keystore.getWallet('pool').address
    const send = await ledger.buildSend({ from: user.address, to: pool, amountMinor: 100, senderKey: userKey, sponsored: true, publicKey: user.publicKey })
    const dep = await ledger.submitUserSigned((await user.sign(send)).tx_blob)
    expect(dep.engineResult).toBe('tesSUCCESS')
    worker.expectDeposit({ intentId: 'ledger_test', txHash: dep.hash, from: user.address, amountMinor: 100 })
    await waitFor(() => events.length > 0, 60_000)
    expect(events[0]).toEqual({ type: 'received', intentId: 'ledger_test', txHash: dep.hash, from: user.address, amountMinor: 100 })

    const out = await worker.payout({ intentId: 'ledger_test', to: user.address, amountMinor: 100 })
    expect(events.filter((e) => e.type === 'paidOut')).toEqual([{ type: 'paidOut', intentId: 'ledger_test', txHash: out.hash, to: user.address, amountMinor: 100 }])
    expect((await worker.payout({ intentId: 'ledger_test', to: user.address, amountMinor: 100 })).hash).toBe(out.hash)
    expect(await ledger.confidentialBalance(user.address, userKey)).toEqual({ spendableMinor: 100, inboxMinor: 100 })
    expect(events.filter((e) => e.type === 'failed')).toEqual([])
  })

  it.skipIf(!HAS_RELAYER)("the relayer merges the recipient's inbox with the permission delegated at sign-up", async () => {
    await worker.mergeInboxFor(user.address)
    expect(await ledger.confidentialBalance(user.address, userKey)).toEqual({ spendableMinor: 200, inboxMinor: 0 })
  })

  it('mintIn: the issuer pays the pool and the pool converts it, once per reference (SPEC §2.7)', async () => {
    const pool = keystore.getWallet('pool').address
    const poolKey = keystore.getElGamal('pool')
    const total = (b: { spendableMinor: number; inboxMinor: number }) => b.spendableMinor + b.inboxMinor
    const before = await ledger.confidentialBalance(pool, poolKey)
    const reference = `ledger-test-${Date.now()}`
    const a = await worker.mintIn(5, reference)
    expect(a.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(total(await ledger.confidentialBalance(pool, poolKey))).toBe(total(before) + 5)
    expect((await worker.mintIn(5, reference)).hash).toBe(a.hash)
    expect(total(await ledger.confidentialBalance(pool, poolKey))).toBe(total(before) + 5)
  })
})
