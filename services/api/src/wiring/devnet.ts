// LEDGER_MODE=devnet: the encrypted key store, the live ledger, and the pool worker on its own thread (it opens its own
// key store from env and its own ledger connection). Loaded with a dynamic import only in this mode.
import { openKeyStoreFromEnv } from '@zecca/keystore'
import { createLiveLedger } from '@zecca/xrpl-core'
import { createPoolWorkerInThread } from '@zecca/pool-worker'
import type { Env } from '../config'
import type { Wiring } from './types'

export async function devnetWiring(env: Env, log: (m: string) => void): Promise<Wiring> {
  const keystore = openKeyStoreFromEnv(env)
  const ledger = createLiveLedger({ network: 'devnet', keystore, ...(env.XRPL_DEVNET_URL ? { url: env.XRPL_DEVNET_URL } : {}) })
  const poolWorker = await createPoolWorkerInThread({ env, log })
  return { keystore, ledger, poolWorker, close: () => ledger.close() }
}
