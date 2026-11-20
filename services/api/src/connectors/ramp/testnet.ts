// What the ramp connector reads from XRPL Testnet (no writes): one transaction by hash, and a live feed of transactions
// touching our treasury. The live version sits on @zecca/xrpl-core's client; unit tests pass a fake.
import { createClient, type XrplClient } from '@zecca/xrpl-core'

export interface TestnetReader {
  /** The rippled `tx` result, or null when the ledger does not know the hash (yet). */
  tx(hash: string): Promise<any | null>
  /** Calls `onTx(hash)` for every validated transaction touching `address`; re-subscribes after a reconnect. Returns a stop function. */
  watch(address: string, onTx: (hash: string) => void): () => void
  close(): Promise<void>
}

export function createLiveTestnetReader(o: { url?: string; log?: (m: string) => void } = {}): TestnetReader {
  const log = o.log ?? (() => {})
  const client: XrplClient = createClient('testnet', { ...(o.url ? { url: o.url } : {}), log })
  return {
    async tx(hash) {
      try {
        return (await client.request({ command: 'tx', transaction: hash })).result
      } catch (e) {
        if ((e as { data?: { error?: string } })?.data?.error === 'txnNotFound') return null
        throw e
      }
    },
    watch(address, onTx) {
      const subscribe = () =>
        void client.request({ command: 'subscribe', accounts: [address] }).catch((e) => log(`[ramp] testnet subscribe failed: ${(e as Error).message}`))
      const offConnected = client.onConnected(subscribe)
      const offTx = client.onTransaction((ev) => {
        const hash = ev.hash ?? ev.transaction?.hash ?? ev.tx_json?.hash
        if (ev.validated && typeof hash === 'string') onTx(hash)
      })
      // 'connected' fires on the first connect too, which subscribes.
      client.connect().catch((e) => log(`[ramp] testnet connect failed: ${(e as Error).message} (the 15 s scan retries)`))
      return () => {
        offConnected()
        offTx()
      }
    },
    close: () => client.close(),
  }
}
