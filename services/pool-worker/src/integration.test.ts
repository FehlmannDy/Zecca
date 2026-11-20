// The pool worker on the shared mock ledger (LEDGER_MODE=mock): the full payment path through the pool, SPEC §2.6.
import { describe, expect, it } from 'vitest'
import type { PoolEvent } from '@zecca/contracts'
import { createMockEnvironment } from '@zecca/ledger-mock'
import { mockRawSigner } from '@zecca/xrpl-core/signer'
import { createMemoryPoolStore, createPoolWorker } from './index'

type Env = ReturnType<typeof createMockEnvironment>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(5)
  }
}

async function signUp(env: Env, credit: number) {
  const user = mockRawSigner()
  await env.ledger.ensureAccount(user.address)
  env.keystore.createUserElGamal(user.address)
  const tx = await env.ledger.buildOnboarding({
    address: user.address,
    publicKey: user.publicKey,
    holderKey: env.keystore.getElGamal({ user: user.address }),
    welcomeCreditMinor: credit,
    delegateMergeTo: env.keystore.getWallet('relayer').address,
  })
  const res = await env.ledger.submitUserSigned((await user.sign(tx)).tx_blob)
  expect(res.engineResult).toBe('tesSUCCESS')
  return user
}

describe('pool worker on the mock ledger', () => {
  it('deposit -> received -> payout -> paidOut -> merge inbox, with the balances to match', async () => {
    const env = createMockEnvironment()
    const pool = env.keystore.getWallet('pool').address
    const payer = await signUp(env, 5000)
    const merchant = await signUp(env, 0)
    const events: PoolEvent[] = []
    const worker = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, pollMs: 1e9, lagMonitor: false })
    for (const t of ['received', 'paidOut', 'failed'] as const) worker.on(t, (e) => events.push(e))
    await worker.start()

    // the payer signs a sponsored confidential send to the pool; the API submits it and then tells the worker the hash
    const send = await env.ledger.buildSend({ from: payer.address, to: pool, amountMinor: 1000, senderKey: env.keystore.getElGamal({ user: payer.address }), sponsored: true, publicKey: payer.publicKey })
    const dep = await env.ledger.submitUserSigned((await payer.sign(send)).tx_blob)
    expect(dep.engineResult).toBe('tesSUCCESS')
    worker.expectDeposit({ intentId: 'int_1', txHash: dep.hash, from: payer.address, amountMinor: 1000 })
    await waitFor(() => events.some((e) => e.type === 'received'))
    expect(events).toEqual([{ type: 'received', intentId: 'int_1', txHash: dep.hash, from: payer.address, amountMinor: 1000 }])
    expect(env.ledger.mock.balances(pool)).toMatchObject({ spendableMinor: 0, inboxMinor: 1000 })

    // payout = amount - fee (50 bps); the fee stays in the pool
    const out = await worker.payout({ intentId: 'int_1', to: merchant.address, amountMinor: 995 })
    expect(events[1]).toEqual({ type: 'paidOut', intentId: 'int_1', txHash: out.hash, to: merchant.address, amountMinor: 995 })
    expect(env.ledger.mock.balances(pool)).toMatchObject({ spendableMinor: 5, inboxMinor: 0 })
    expect(env.ledger.mock.balances(merchant.address)).toMatchObject({ spendableMinor: 0, inboxMinor: 995 })
    expect(worker.status()).toEqual({ spendableMinor: 5, inboxMinor: 0, queue: 0 })

    // the relayer merges the merchant's inbox with the delegated permission granted at sign-up
    const merged = await worker.mergeInboxFor(merchant.address)
    expect(merged.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(env.ledger.mock.balances(merchant.address)).toMatchObject({ spendableMinor: 995, inboxMinor: 0 })
    expect(env.ledger.mock.balances(payer.address)).toMatchObject({ spendableMinor: 4000, inboxMinor: 0 })

    // a second payout call for the same intent changes nothing
    expect((await worker.payout({ intentId: 'int_1', to: merchant.address, amountMinor: 995 })).hash).toBe(out.hash)
    expect(env.ledger.mock.balances(merchant.address).spendableMinor).toBe(995)
    expect(events.filter((e) => e.type === 'failed')).toEqual([])
    await worker.stop()
  })

  it('a deposit seen on the stream before expectDeposit, and an amount mismatch, on the mock ledger', async () => {
    const env = createMockEnvironment()
    const pool = env.keystore.getWallet('pool').address
    const payer = await signUp(env, 5000)
    const events: PoolEvent[] = []
    const worker = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, pollMs: 1e9, lagMonitor: false })
    for (const t of ['received', 'paidOut', 'failed'] as const) worker.on(t, (e) => events.push(e))
    await worker.start()
    const key = env.keystore.getElGamal({ user: payer.address })
    const a = await env.ledger.submitUserSigned((await payer.sign(await env.ledger.buildSend({ from: payer.address, to: pool, amountMinor: 300, senderKey: key, sponsored: true, publicKey: payer.publicKey }))).tx_blob)
    const b = await env.ledger.submitUserSigned((await payer.sign(await env.ledger.buildSend({ from: payer.address, to: pool, amountMinor: 400, senderKey: key, sponsored: true, publicKey: payer.publicKey }))).tx_blob)
    await sleep(10) // both are already on the stream
    worker.expectDeposit({ intentId: 'ok', txHash: a.hash, from: payer.address, amountMinor: 300 })
    worker.expectDeposit({ intentId: 'bad', txHash: b.hash, from: payer.address, amountMinor: 450 })
    await waitFor(() => events.length === 2)
    expect(events.find((e) => e.intentId === 'ok')).toMatchObject({ type: 'received', amountMinor: 300 })
    expect(events.find((e) => e.intentId === 'bad')).toMatchObject({ type: 'failed', stage: 'deposit', code: 'amount_mismatch' })
    await worker.stop()
  })

  it('mints a top-up into the pool once per reference', async () => {
    const env = createMockEnvironment()
    const pool = env.keystore.getWallet('pool').address
    const worker = createPoolWorker({ ledger: env.ledger, keystore: env.keystore, store: createMemoryPoolStore(), log: () => {}, lagMonitor: false })
    const a = await worker.mintIn(2500, 'TESTNET-DELIVERY-HASH')
    const b = await worker.mintIn(2500, 'TESTNET-DELIVERY-HASH')
    expect(b.hash).toBe(a.hash)
    expect(env.ledger.mock.balances(pool)).toMatchObject({ publicMinor: 0, inboxMinor: 2500 })
  })
})
