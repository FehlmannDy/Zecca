// LedgerReader over any public XRPL node (xrpl.js Client), for checkStatement. Read-only: tx and ledger_entry.
import xrpl from 'xrpl'
import type { Network } from '@zecca/contracts'
import type { LedgerReader } from './verify'

export const PUBLIC_NODES: Record<Network, string> = {
  devnet: 'wss://s.devnet.rippletest.net:51233',
  testnet: 'wss://s.altnet.rippletest.net:51233',
}

type Raw = Record<string, any>
const errorCode = (e: unknown) => (e as Raw)?.data?.error as string | undefined

export function xrplReader(client: xrpl.Client): LedgerReader & { close(): Promise<void> } {
  const ready = async () => {
    if (!client.isConnected()) await client.connect()
  }
  return {
    async tx(hash) {
      await ready()
      try {
        const r = ((await client.request({ command: 'tx', transaction: hash } as never)) as Raw).result as Raw
        return { validated: Boolean(r.validated), engineResult: String(r.meta?.TransactionResult ?? 'unknown'), tx: (r.tx_json ?? r) as Record<string, unknown> }
      } catch (e) {
        if (errorCode(e) === 'txnNotFound') return null
        throw e
      }
    },
    async encryptionKey(account, issuanceId) {
      await ready()
      try {
        const r = ((await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: issuanceId, account }, ledger_index: 'validated' } as never)) as Raw).result as Raw
        return r.node?.HolderEncryptionKey as string | undefined
      } catch (e) {
        if (errorCode(e) === 'entryNotFound') return undefined
        throw e
      }
    },
    async close() {
      if (client.isConnected()) await client.disconnect()
    },
  }
}
