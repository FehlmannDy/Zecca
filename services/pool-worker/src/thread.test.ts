import { afterEach, describe, expect, it } from 'vitest'
import type { PoolEvent, PoolWorker } from '@zecca/contracts'
import { createPoolWorkerInThread, preloadArgs } from './thread'

const FAKE = new URL('./testing/fake-thread-deps.ts', import.meta.url).href
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(10)
  }
}

describe('preloadArgs', () => {
  it('keeps -r/--require preloads and drops --env-file and everything else', () => {
    expect(
      preloadArgs(['-r', '/x/dnsfix.cjs', '--env-file=.env', '--env-file', '.env', '--require=/y.cjs', '--import', 'file:///tsx/loader.mjs', '--require', '/z.cjs', '--watch']),
    ).toEqual(['-r', '/x/dnsfix.cjs', '--require=/y.cjs', '--require', '/z.cjs'])
  })
})

describe('pool worker in a worker thread', () => {
  let w: PoolWorker | undefined
  afterEach(async () => {
    await w?.stop().catch(() => {})
    w = undefined
  })

  it('runs the worker in a thread: RPC for every method, events forwarded, status mirrored', async () => {
    const logs: string[] = []
    w = await createPoolWorkerInThread({ env: { FAKE_DEPOSIT_MINOR: '700', FAKE_POOL_SPENDABLE: '5000' }, log: (m) => logs.push(m), factory: FAKE })
    const events: PoolEvent[] = []
    for (const t of ['received', 'paidOut', 'failed'] as const) w.on(t, (e) => events.push(e))
    await w.start()
    expect(logs.some((l) => l.includes('[pool] watching'))).toBe(true) // logs come back from the thread

    // the fake ledger in the thread holds one deposit whose hash is derived from the env
    const hash = 'D'.repeat(64)
    w.expectDeposit({ intentId: 'i1', txHash: hash, from: 'rFakeUserAccount1111111111111', amountMinor: 700 })
    await waitFor(() => events.some((e) => e.type === 'received'))
    expect(events.find((e) => e.type === 'received')).toEqual({ type: 'received', intentId: 'i1', txHash: hash, from: 'rFakeUserAccount1111111111111', amountMinor: 700 })

    const out = await w.payout({ intentId: 'i1', to: 'rFakeMerchantAccount111111111', amountMinor: 690 })
    expect(out.hash).toMatch(/^[0-9A-F]{64}$/)
    await waitFor(() => events.some((e) => e.type === 'paidOut'))
    expect(events.find((e) => e.type === 'paidOut')).toMatchObject({ intentId: 'i1', txHash: out.hash, amountMinor: 690 })
    await waitFor(() => w!.status().spendableMinor === 4310)
    expect(w.status()).toMatchObject({ spendableMinor: 4310, queue: 0 })

    expect((await w.mintIn(100, 'ref-1')).hash).toMatch(/^[0-9A-F]{64}$/)
    expect((await w.mergeInboxFor('rFakeMerchantAccount111111111')).hash).toMatch(/^[0-9A-F]{64}$/)
  })

  it('rejects with the error from the thread and keeps serving', async () => {
    w = await createPoolWorkerInThread({ env: {}, log: () => {}, factory: FAKE })
    await expect(w.payout({ intentId: 'x', to: 'rFakeMerchantAccount111111111', amountMinor: 10 })).rejects.toThrow(/insufficient funds/)
    await expect(w.payout({ intentId: 'y', to: 'rFakeMerchantAccount111111111', amountMinor: 1.5 })).rejects.toMatchObject({ code: 'invalid_amount' })
    expect((await w.mintIn(10, 'ref-2')).hash).toMatch(/^[0-9A-F]{64}$/)
  })

  it('passes env explicitly to the thread (its process.env is exactly that env)', async () => {
    const logs: string[] = []
    w = await createPoolWorkerInThread({ env: { FAKE_ECHO: 'hello' }, log: (m) => logs.push(m), factory: FAKE })
    expect(logs).toContain('[fake] process.env FAKE_ECHO=hello PATH=unset')
  })

  it('fails to start when the factory throws, with its message', async () => {
    await expect(createPoolWorkerInThread({ env: { FAKE_FAIL: '1' }, log: () => {}, factory: FAKE })).rejects.toThrow(/fake factory refused/)
  })

  it('the default devnet factory loads in the thread and refuses to start without its key store (no network touched)', async () => {
    await expect(createPoolWorkerInThread({ env: {}, log: () => {} })).rejects.toThrow(/createLiveLedger|KEYSTORE_PASSPHRASE/)
  })

  it('rejects calls after stop()', async () => {
    const t = await createPoolWorkerInThread({ env: {}, log: () => {}, factory: FAKE })
    await t.stop()
    await expect(t.mintIn(1, 'r')).rejects.toThrow(/stopped|exited/)
  })
})
