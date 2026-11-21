// Devnet: a refund's way back on the live ledger, card settlement account -> pool (returns.ts), for 1 cent.
// Run unsandboxed from zecca/: npm run test:ledger -- services/api/src/connectors/card/returns.ledger.test.ts
import { afterAll, describe, expect, it } from 'vitest'
import { createMemoryKeyStore, openKeyStoreFromEnv } from '@zecca/keystore'
import { createLiveLedger } from '@zecca/xrpl-core'
import type { Core } from '../../core'
import { openDb } from '../../db'
import type { CardCtx } from './context'
import { sendReturns } from './returns'
import { cardStore } from './store'

const ON = Boolean(process.env.KEYSTORE_PASSPHRASE)

describe.skipIf(!ON)('a refund back to the pool on Devnet', () => {
  // In-memory copy of the product key store: nothing is written to the file.
  const keystore = ON ? createMemoryKeyStore({ initial: openKeyStoreFromEnv(process.env).snapshot() }) : undefined!
  const ledger = ON ? createLiveLedger({ network: 'devnet', keystore }) : undefined!
  afterAll(async () => ledger?.close())

  it('sends the refunded cent from the card settlement account to the pool, once', async () => {
    const logs: string[] = []
    const log = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) }
    const core = { keystore, ledger, log } as unknown as Core
    const store = cardStore({ db: openDb(':memory:'), iso: (ms?: number) => new Date(ms ?? Date.now()).toISOString() })
    const ctx = { store } as unknown as CardCtx
    const key = `ledger-test-${Date.now()}:return`
    store.refund({ key, userId: 'u_ledger_test', cardToken: 'card_ledger_test', amountMinor: 1, merchant: 'Sette Archi' })

    await sendReturns(core, ctx)
    const r = store.returnOf(key)
    expect(r, logs.join('\n')).toMatchObject({ status: 'sent' })
    const e = await ledger.txByHash(r!.txHash!)
    expect(e).toMatchObject({ validated: true, engineResult: 'tesSUCCESS' })
    expect(e!.tx).toMatchObject({ TransactionType: 'ConfidentialMPTSend', Account: keystore.getWallet('cardSettlement').address, Destination: keystore.getWallet('pool').address })

    await sendReturns(core, ctx)
    expect(store.returnOf(key)?.txHash).toBe(r!.txHash)
  }, 120_000)
})
