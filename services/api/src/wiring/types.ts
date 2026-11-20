import type { KeyStore, Ledger, PoolWorker } from '@zecca/contracts'

export type Wiring = { keystore: KeyStore; ledger: Ledger; poolWorker: PoolWorker; close(): Promise<void> }
