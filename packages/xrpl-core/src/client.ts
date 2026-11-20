// XRPL client factory. One place for what was copied four times (HANDOFF "Shared pieces"):
// connect once, reconnect (xrpl.js reconnects on its own and emits 'connected' again), submit and wait for validation,
// and one serial queue per account (BUILD §8 rule 7: proofs are bound to the sequence and the balance version).
import xrpl from 'xrpl'
import { decode } from 'ripple-binary-codec'
import type { Network, SubmitResult } from '@zecca/contracts'
import { tfAllOrNothing } from './batch'

export const NETWORK_URLS: Record<Network, string> = {
  devnet: 'wss://s.devnet.rippletest.net:51233',
  testnet: 'wss://s.altnet.rippletest.net:51233',
}

/** The surface of xrpl.Client we use. Lets unit tests inject a fake. */
export type RawClient = {
  request(req: Record<string, unknown>): Promise<any>
  connect(): Promise<void>
  disconnect(): Promise<void>
  isConnected(): boolean
  on(event: string, cb: (...a: any[]) => void): unknown
  removeListener(event: string, cb: (...a: any[]) => void): unknown
  autofill(tx: any, signersCount?: number): Promise<any>
}

export type Log = (msg: string) => void

export interface XrplClient {
  readonly network: Network
  readonly url: string
  /** The xrpl.Client itself, for xrpl.prepareConfidential* helpers. */
  readonly raw: xrpl.Client
  connect(): Promise<void>
  /** Same shape as xrpl.Client.request (the response, with `.result`). Connects first. */
  request(req: Record<string, unknown>): Promise<any>
  /** Last validated ledger index. */
  ledgerIndex(): Promise<number>
  /** account_data at the validated ledger, or null when the account does not exist. */
  accountInfo(address: string): Promise<Record<string, any> | null>
  /** Next Sequence of an account, from the current (open) ledger so pending txs count. */
  nextSequence(address: string): Promise<number>
  /** Current base fee in drops (base fee x load factor). */
  baseFeeDrops(): Promise<number>
  autofill<T extends Record<string, unknown>>(tx: T, signersCount?: number): Promise<T>
  submitAndWait(txBlob: string): Promise<SubmitResult>
  /** Runs fn after every earlier task of the same account settled. */
  serial<T>(account: string, fn: () => Promise<T>): Promise<T>
  queueLength(account?: string): number
  /** Called on every (re)connect. Returns an unsubscribe function. */
  onConnected(cb: () => void): () => void
  /** Raw 'transaction' stream events. Returns an unsubscribe function. */
  onTransaction(cb: (ev: Record<string, any>) => void): () => void
  close(): Promise<void>
}

export type CreateClientOptions = { url?: string; raw?: RawClient; pollMs?: number; log?: Log; /** Base delay between connect retries. */ retryMs?: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** ter codes that will not resolve by waiting in our flows (seen on Devnet: a relayer merge without the DelegateSet). */
const FAIL_FAST = ['terNO_DELEGATE_PERMISSION']
/** Zecca's result for an AllOrNothing Batch whose outer tx validated (fee and sequence used) but whose inner txs did not apply. */
export const BATCH_INNER_FAILED = 'tecBATCH_INNER_FAILED'
const errCode = (e: unknown) => (e as { data?: { error?: string } })?.data?.error
/** xrpl.js errors thrown when the socket is down or dropped mid-request. */
const isConnectionError = (e: unknown) => ['NotConnectedError', 'DisconnectedError', 'ConnectionError'].includes(String((e as Error)?.name))
const CONNECT_ATTEMPTS = 4

export function createClient(network: Network, opts: CreateClientOptions = {}): XrplClient {
  const url = opts.url ?? NETWORK_URLS[network]
  const raw: RawClient = opts.raw ?? (new xrpl.Client(url, { timeout: 60_000, connectionTimeout: 30_000 }) as unknown as RawClient)
  const log = opts.log ?? (() => {})
  const pollMs = opts.pollMs ?? 1000
  const retryMs = opts.retryMs ?? 1000
  // xrpl.Client re-emits connection errors; keep them from crashing the process.
  raw.on('error', (code: unknown, message: unknown) => log(`[xrpl ${network}] ${String(code)} ${String(message ?? '')}`))

  let connecting: Promise<void> | null = null
  const connect = async () => {
    if (raw.isConnected()) return
    connecting ??= (async () => {
      for (let i = 1; ; i++) {
        try {
          return await raw.connect()
        } catch (e) {
          if (i >= CONNECT_ATTEMPTS) throw e
          log(`[xrpl ${network}] connect failed (${String((e as Error).message)}), retry ${i}`)
          await sleep(retryMs * i)
        }
      }
    })().finally(() => (connecting = null))
    return connecting
  }
  /** Connects first. A read whose socket dropped is retried once; a submit is not (see submitAndWait). */
  const request = async (req: Record<string, unknown>) => {
    await connect()
    try {
      return await raw.request(req)
    } catch (e) {
      if (!isConnectionError(e) || req.command === 'submit') throw e
      await connect()
      return raw.request(req)
    }
  }
  const ledgerIndex = async () => Number((await request({ command: 'ledger', ledger_index: 'validated' })).result.ledger_index)

  const queues = new Map<string, { tail: Promise<unknown>; pending: number }>()

  const client: XrplClient = {
    network,
    url,
    raw: raw as unknown as xrpl.Client,
    connect,
    request,
    ledgerIndex,
    async accountInfo(address) {
      try {
        return (await request({ command: 'account_info', account: address, ledger_index: 'validated' })).result.account_data
      } catch (e) {
        if (errCode(e) === 'actNotFound') return null
        throw e
      }
    },
    async nextSequence(address) {
      return Number((await request({ command: 'account_info', account: address, ledger_index: 'current' })).result.account_data.Sequence)
    },
    async baseFeeDrops() {
      const info = (await request({ command: 'server_info' })).result.info
      const base = Number(info.validated_ledger?.base_fee_xrp ?? 0.00001)
      // drops are integers: round the XRP value to drops first, then apply the load factor
      return Math.ceil(Math.round(base * 1_000_000) * Number(info.load_factor ?? 1))
    },
    async autofill(tx, signersCount) {
      await connect()
      return raw.autofill(tx, signersCount)
    },
    async submitAndWait(txBlob) {
      const hash = xrpl.hashes.hashSignedTx(txBlob)
      const decoded = decode(txBlob) as { LastLedgerSequence?: number; TransactionType?: string; Flags?: number; RawTransactions?: { RawTransaction: object }[] }
      const lls = decoded.LastLedgerSequence
      // Devnet: an AllOrNothing Batch validates tesSUCCESS even when its inner txs were not applied
      // (outer 89A1D59F...E635, inners txnNotFound). Done means every inner tx is in the ledger with tesSUCCESS.
      const innerHashes =
        decoded.TransactionType === 'Batch' && ((decoded.Flags ?? 0) & tfAllOrNothing) !== 0
          ? (decoded.RawTransactions ?? []).map((r) => xrpl.hashes.hashSignedTx(r.RawTransaction as never))
          : []
      const innersApplied = async () => {
        for (const h of innerHashes) {
          try {
            const r = (await request({ command: 'tx', transaction: h })).result
            if (!r.validated || r.meta?.TransactionResult !== 'tesSUCCESS') return false
          } catch (e) {
            if (errCode(e) === 'txnNotFound') return false
            throw e
          }
        }
        return true
      }
      const submit = async () => String((await request({ command: 'submit', tx_blob: txBlob })).result.engine_result)
      let prelim: string
      // When the socket dropped during the submit, the server may or may not have the tx: send it again, and read a
      // tef reply (tefPAST_SEQ, tefALREADY) as "may have applied" and wait for it by hash.
      let maybeSent = false
      try {
        try {
          prelim = await submit()
        } catch (e) {
          if (!isConnectionError(e)) throw e
          maybeSent = true
          prelim = await submit()
        }
      } catch (e) {
        return { validated: false, engineResult: errCode(e) ?? 'SUBMIT_ERROR', hash }
      }
      // Never applied: no point waiting for the LastLedgerSequence.
      const neverApplied = /^(tem|tel)/.test(prelim) || (/^tef/.test(prelim) && !maybeSent) || FAIL_FAST.includes(prelim)
      if (neverApplied) return { validated: false, engineResult: prelim, hash }
      const started = Date.now()
      const check = async (): Promise<SubmitResult | null> => {
        try {
          const r = (await request({ command: 'tx', transaction: hash })).result
          if (r.validated) {
            let engineResult = String(r.meta?.TransactionResult ?? 'unknown')
            if (engineResult === 'tesSUCCESS' && !(await innersApplied())) engineResult = BATCH_INNER_FAILED
            return { validated: engineResult === 'tesSUCCESS', engineResult, hash, ledgerIndex: Number(r.ledger_index), meta: r.meta }
          }
        } catch (e) {
          if (errCode(e) !== 'txnNotFound') log(`[xrpl ${network}] tx ${hash}: ${String((e as Error).message)}`)
        }
        return null
      }
      for (;;) {
        await sleep(pollMs)
        const done = await check()
        if (done) return done
        const current = lls != null ? await ledgerIndex().catch(() => -1) : -1
        const expired = lls != null ? current > lls : Date.now() - started > 120_000
        if (expired) return (await check()) ?? { validated: false, engineResult: /^ter/.test(prelim) && prelim !== 'terQUEUED' ? prelim : 'tefMAX_LEDGER', hash }
      }
    },
    serial(account, fn) {
      const q = queues.get(account) ?? { tail: Promise.resolve(), pending: 0 }
      queues.set(account, q)
      q.pending++
      const run = q.tail.then(fn, fn)
      q.tail = run.catch(() => {}).finally(() => {
        if (--q.pending === 0 && queues.get(account) === q) queues.delete(account)
      })
      return run
    },
    queueLength(account) {
      if (account) return queues.get(account)?.pending ?? 0
      let n = 0
      for (const q of queues.values()) n += q.pending
      return n
    },
    onConnected(cb) {
      raw.on('connected', cb)
      return () => void raw.removeListener('connected', cb)
    },
    onTransaction(cb) {
      raw.on('transaction', cb)
      return () => void raw.removeListener('transaction', cb)
    },
    async close() {
      if (raw.isConnected()) await raw.disconnect()
    },
  }
  return client
}
