// Dependency factory for the thread RPC test: the fake ledger, a fake key store and a memory store, built inside the thread.
import type { PoolDeps } from '../thread-entry'
import { createMemoryPoolStore } from '../store'
import { ADDR, createFakeLedger, fakeKeyStore } from './fake-ledger'

export async function createPoolDeps(env: Record<string, string | undefined>, { log }: { log: (m: string) => void }): Promise<PoolDeps> {
  if (env.FAKE_FAIL) throw new Error('fake factory refused to start')
  if (env.FAKE_ECHO) log(`[fake] process.env FAKE_ECHO=${process.env.FAKE_ECHO} PATH=${process.env.PATH ?? 'unset'}`)
  const ledger = createFakeLedger()
  if (env.FAKE_POOL_SPENDABLE) ledger.t.setBal(ADDR.pool, { spendableMinor: Number(env.FAKE_POOL_SPENDABLE) })
  if (env.FAKE_DEPOSIT_MINOR) ledger.t.deposit({ from: 'rFakeUserAccount1111111111111', amountMinor: Number(env.FAKE_DEPOSIT_MINOR), hash: 'D'.repeat(64), stream: false })
  // A deposit that lands on the stream after start (once the first status has gone out).
  if (env.FAKE_LATE_DEPOSIT_MINOR)
    setTimeout(() => ledger.t.deposit({ from: 'rFakeUserAccount1111111111111', amountMinor: Number(env.FAKE_LATE_DEPOSIT_MINOR), hash: 'E'.repeat(64) }), Number(env.FAKE_LATE_DEPOSIT_MS ?? 300)).unref()
  return { ledger, keystore: fakeKeyStore(), store: createMemoryPoolStore(), close: () => ledger.close() }
}
