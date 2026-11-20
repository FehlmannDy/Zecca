// LEDGER_MODE=mock: the in-memory ledger and key store, and the pool worker in process on a memory store.
import { createMockEnvironment } from '@zecca/ledger-mock'
import { createMemoryPoolStore, createPoolWorker } from '@zecca/pool-worker'
import type { Env } from '../config'
import type { Wiring } from './types'

export async function mockWiring(env: Env, log: (m: string) => void): Promise<Wiring> {
  const delay = Number.parseInt(env.MOCK_VALIDATION_DELAY_MS ?? '', 10)
  const { keystore, ledger } = createMockEnvironment({ validationDelayMs: Number.isSafeInteger(delay) && delay >= 0 ? delay : 500 })
  const poolWorker = createPoolWorker({ ledger, keystore, store: createMemoryPoolStore(), log })
  return { keystore, ledger, poolWorker, close: () => ledger.close() }
}
