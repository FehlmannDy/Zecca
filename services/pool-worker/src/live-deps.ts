// Default thread factory (devnet): the thread opens its own key store from env and its own live ledger connection.
import type { KeyStore, Ledger } from '@zecca/contracts'
import { openKeyStoreFromEnv } from '@zecca/keystore'
import { createSqlitePoolStore } from './store'
import type { PoolDeps } from './thread-entry'

type CreateLiveLedger = (o: { network: 'devnet' | 'testnet'; keystore: KeyStore; issuanceId?: string; url?: string }) => Ledger | Promise<Ledger>

export async function createPoolDeps(env: Record<string, string | undefined>): Promise<PoolDeps> {
  const core = (await import('@zecca/xrpl-core')) as { createLiveLedger?: CreateLiveLedger }
  if (typeof core.createLiveLedger !== 'function') throw new Error('@zecca/xrpl-core does not export createLiveLedger yet')
  const keystore = openKeyStoreFromEnv(env)
  const ledger = await core.createLiveLedger({ network: 'devnet', keystore, ...(env.XRPL_DEVNET_URL ? { url: env.XRPL_DEVNET_URL } : {}) })
  const store = createSqlitePoolStore(env.POOL_DB_PATH ?? './.data/pool.sqlite')
  return {
    ledger,
    keystore,
    store,
    async close() {
      await ledger.close()
      store.close()
    },
  }
}
