// The live Ledger (contracts/interfaces.ts) over the pieces of this package: client, fill, sponsor, batch, confidential.
import type { KeyStore, Ledger, LedgerTxEvent, Network, SubmitResult, UnsignedTx, WalletRole } from '@zecca/contracts'
import { createClient, type Log, type XrplClient } from './client'
import { tfSponsorCreatedAccount } from './batch'
import { fillTx } from './fill'
import { cosignAsSponsor } from './sponsor'
import { walletFrom } from './wallet'
import * as conf from './confidential'

export type LiveLedgerOptions = {
  network: Network
  keystore: KeyStore
  /** Defaults to keystore.getMeta('cmptIssuanceId'). */
  issuanceId?: string
  url?: string
  /** Injected client (tests, or to share one connection). */
  client?: XrplClient
  log?: Log
}

export type LiveLedger = Ledger & { readonly client: XrplClient }

type Raw = Record<string, any>

/** account_tx item, tx response or stream message (API v2 tx_json, or v1 transaction/tx) -> LedgerTxEvent. */
export function toLedgerTxEvent(r: Raw): LedgerTxEvent {
  const tx = r.tx_json ?? r.transaction ?? r.tx ?? {}
  return {
    hash: String(r.hash ?? tx.hash ?? ''),
    ledgerIndex: Number(r.ledger_index ?? tx.ledger_index ?? 0),
    validated: Boolean(r.validated),
    engineResult: String(r.meta?.TransactionResult ?? r.engine_result ?? 'unknown'),
    tx,
    meta: r.meta,
    closeTime: r.close_time_iso,
  }
}

export function createLiveLedger(opts: LiveLedgerOptions): LiveLedger {
  const { keystore, network } = opts
  const log = opts.log ?? (() => {})
  const issuanceId = opts.issuanceId ?? keystore.getMeta('cmptIssuanceId')
  if (!issuanceId) throw new Error('no CMPT issuance id: pass issuanceId or set key store meta cmptIssuanceId (scripts/bootstrap-ledger.ts)')
  const client = opts.client ?? createClient(network, { url: opts.url, log })
  const ctx: conf.ConfidentialContext = { client, keystore, issuanceId }
  const sponsor = () => walletFrom(keystore.getWallet('sponsor'))

  async function submitAs(role: WalletRole, tx: UnsignedTx): Promise<SubmitResult> {
    const wallet = walletFrom(keystore.getWallet(role))
    if (tx.Account !== wallet.classicAddress && tx.Delegate !== wallet.classicAddress) throw new Error(`role ${role} cannot sign a tx of ${tx.Account}`)
    // The sequence consumed is the Account's (also for a delegated tx), so the queue is the Account's.
    return client.serial(tx.Account, async () => {
      const filled = await fillTx(client, tx, {})
      let blob = wallet.sign(filled as never).tx_blob
      if (filled.Sponsor && filled.Sponsor !== wallet.classicAddress) blob = cosignAsSponsor(sponsor(), blob).tx_blob
      return client.submitAndWait(blob)
    })
  }

  // ---- watching: one stream listener, one subscription per watched account, re-subscribed on reconnect ----
  const watchers = new Map<string, Set<(e: LedgerTxEvent) => void>>()
  const subscribe = (accounts: string[]) => {
    if (accounts.length) client.request({ command: 'subscribe', accounts }).catch((e) => log(`[ledger] subscribe: ${String((e as Error).message)}`))
  }
  let stopStream: (() => void) | null = null
  const startStream = () => {
    if (stopStream) return
    const offTx = client.onTransaction((ev) => {
      if (!ev.validated) return
      const e = toLedgerTxEvent(ev)
      const text = JSON.stringify(e.tx) + JSON.stringify(e.meta ?? {})
      for (const [address, cbs] of watchers) {
        if (!text.includes(address)) continue
        for (const cb of cbs) {
          try {
            cb(e)
          } catch (err) {
            log(`[ledger] watcher of ${address} threw: ${String((err as Error).message)}`)
          }
        }
      }
    })
    const offConn = client.onConnected(() => subscribe([...watchers.keys()]))
    stopStream = () => (offTx(), offConn(), (stopStream = null))
  }

  const ledger: LiveLedger = {
    network,
    mode: 'live',
    issuanceId,
    client,

    ledgerIndex: () => client.ledgerIndex(),
    accountExists: async (address) => (await client.accountInfo(address)) != null,
    ensureAccount: (address) =>
      client.serial(`ensure:${address}`, async () => {
        if (await client.accountInfo(address)) return { created: false }
        const s = sponsor()
        const r = await submitAs('sponsor', { TransactionType: 'Payment', Account: s.classicAddress, Destination: address, Amount: '1', Flags: tfSponsorCreatedAccount })
        if (!r.validated) throw new Error(`sponsored account creation for ${address}: ${r.engineResult}`)
        return { created: true, hash: r.hash }
      }),

    buildOnboarding: (p) => conf.buildOnboarding(ctx, p),
    buildSend: (p) => conf.buildSend(ctx, p),
    buildMergeInbox: (p) => conf.buildMergeInbox(ctx, p),
    buildConvert: (p) => conf.buildConvert(ctx, p),
    prepareSponsored: (tx, o = {}) => fillTx(client, tx, { sponsor: sponsor().classicAddress, reserve: o.reserve, publicKey: o.publicKey }),

    async submitUserSigned(txBlob) {
      return client.submitAndWait(cosignAsSponsor(sponsor(), txBlob).tx_blob)
    },
    submitAs,

    confidentialBalance: (address, key) => conf.confidentialBalance(ctx, address, key),
    // Capped by today's confidential supply: Zecca never converts back or claws back, so the supply only grows and any
    // amount ever sent (e.g. a deposit's DestinationEncryptedAmount) is below it.
    decryptAmount: async (ct, pk) => conf.decryptBounded(ct, pk, conf.DECRYPT_BOUNDS, conf.supplyBound(await conf.fetchIssuance(client, issuanceId))),
    async mptBalance(address, id) {
      const token = await conf.fetchMPToken(client, address, id)
      return Number(token?.MPTAmount ?? 0)
    },

    watchAccount(address, onTx) {
      startStream()
      // Per-watcher dedup: a tx can reach us more than once (several watched accounts, reconnects).
      const seen = new Set<string>()
      const cb = (e: LedgerTxEvent) => {
        if (seen.has(e.hash)) return
        seen.add(e.hash)
        if (seen.size > 2000) seen.delete(seen.values().next().value as string)
        onTx(e)
      }
      let set = watchers.get(address)
      if (!set) {
        set = new Set()
        watchers.set(address, set)
        subscribe([address])
      }
      set.add(cb)
      return () => {
        const s = watchers.get(address)
        if (!s?.delete(cb) || s.size) return
        watchers.delete(address)
        client.request({ command: 'unsubscribe', accounts: [address] }).catch(() => {})
      }
    },
    async accountTx(address, limit = 20) {
      const r = (await client.request({ command: 'account_tx', account: address, limit, forward: false })).result
      return (r.transactions as Raw[]).filter((t) => t.validated).map(toLedgerTxEvent)
    },
    async txByHash(hash) {
      try {
        return toLedgerTxEvent((await client.request({ command: 'tx', transaction: hash })).result)
      } catch (e) {
        if ((e as Raw)?.data?.error === 'txnNotFound') return null
        throw e
      }
    },
    async close() {
      stopStream?.()
      watchers.clear()
      await client.close()
    },
  }
  return ledger
}
