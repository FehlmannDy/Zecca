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
  /**
   * Submits and waits for the outcome. `validated` is true only for tesSUCCESS in a validated ledger (a validated tec,
   * and BATCH_INNER_FAILED, give validated: false with ledgerIndex set; the ledger-mock reports validated: true for tec).
   * tem, FAIL_FAST and a first-answer tef/tel (not tefALREADY) return at once. A lost answer is waited for by hash;
   * OUTCOME_UNKNOWN means the outcome could not be learnt (the tx may have validated).
   */
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

export type CreateClientOptions = {
  url?: string
  raw?: RawClient
  pollMs?: number
  log?: Log
  /** Base delay between connect retries. */
  retryMs?: number
  /** submitAndWait gives up (outcome unknown) after this long when it cannot learn whether LastLedgerSequence passed. */
  maxWaitMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** ter codes that will not resolve by waiting in our flows (seen on Devnet: a relayer merge without the DelegateSet). */
const FAIL_FAST = ['terNO_DELEGATE_PERMISSION']
/** Zecca's result for an AllOrNothing Batch whose outer tx validated (fee and sequence used) but whose inner txs did not apply. */
export const BATCH_INNER_FAILED = 'tecBATCH_INNER_FAILED'
/** The outcome is not known: the tx may still validate, or may have validated. Callers settle it from the ledger later. */
export const OUTCOME_UNKNOWN = 'SUBMIT_ERROR'
/** Status reads tried once LastLedgerSequence has passed, before concluding anything. */
const FINAL_READS = 3
const errCode = (e: unknown) => (e as { data?: { error?: string } })?.data?.error
/** xrpl.js errors thrown when the socket is down or dropped mid-request. */
const isConnectionError = (e: unknown) => ['NotConnectedError', 'DisconnectedError', 'ConnectionError'].includes(String((e as Error)?.name))
const CONNECT_ATTEMPTS = 4
/** rippled answers that say "this node cannot serve you right now"; nothing was applied, so another node may answer. */
const UNHEALTHY_NODE = new Set(['amendmentBlocked', 'notSynced', 'noNetwork', 'noCurrent', 'noClosed', 'tooBusy'])
const NODE_ATTEMPTS = 6

export function createClient(network: Network, opts: CreateClientOptions = {}): XrplClient {
  const url = opts.url ?? NETWORK_URLS[network]
  const raw: RawClient = opts.raw ?? (new xrpl.Client(url, { timeout: 60_000, connectionTimeout: 30_000 }) as unknown as RawClient)
  const log = opts.log ?? (() => {})
  const pollMs = opts.pollMs ?? 1000
  const retryMs = opts.retryMs ?? 1000
  // User txs get 150 ledgers (about 10 minutes on Devnet); past this we cannot even tell whether that window passed.
  const maxWaitMs = opts.maxWaitMs ?? 15 * 60_000
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
  const once = async (req: Record<string, unknown>) => {
    await connect()
    try {
      return await raw.request(req)
    } catch (e) {
      if (!isConnectionError(e) || req.command === 'submit') throw e
      await connect()
      return raw.request(req)
    }
  }
  /** One request. An unhealthy node (amendmentBlocked, notSynced, ...) is left: a new connection through the hub's
   * load balancer reaches another node. Safe for a submit too: an unhealthy node applies nothing. */
  const request = async (req: Record<string, unknown>) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await once(req)
      } catch (e) {
        const code = errCode(e)
        if (!code || !UNHEALTHY_NODE.has(code) || attempt >= NODE_ATTEMPTS) throw e
        log(`[xrpl ${network}] node answered ${code}; reconnecting to another node (try ${attempt})`)
        await raw.disconnect().catch(() => {})
        await sleep(retryMs * attempt)
      }
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
      // Only an answer from rippled (engine result, or an error such as invalidTransaction) tells what the server did with
      // the tx. When the answer is lost (socket dropped, TimeoutError, anything else) the server may hold it: a dropped
      // socket is sent once more, then whatever happens the tx is waited for by hash until LastLedgerSequence.
      let prelim = OUTCOME_UNKNOWN
      let maybeSent = false
      try {
        prelim = await submit()
      } catch (e) {
        const refused = errCode(e)
        if (refused && !isConnectionError(e)) return { validated: false, engineResult: refused, hash }
        maybeSent = true
        if (isConnectionError(e)) prelim = await submit().catch(() => OUTCOME_UNKNOWN)
      }
      // Never applied: no point waiting for the LastLedgerSequence. After a lost answer a tef/tel may be about our own
      // first send (tefPAST_SEQ, tefALREADY), and tefALREADY means the server already holds this very tx.
      const neverApplied = /^tem/.test(prelim) || FAIL_FAST.includes(prelim) || (!maybeSent && /^(tef|tel)/.test(prelim) && prelim !== 'tefALREADY')
      if (neverApplied) return { validated: false, engineResult: prelim, hash }
      const started = Date.now()
      /** The validated result, 'pending' (not in a validated ledger yet), or 'unreadable' (the lookup failed). */
      const check = async (): Promise<SubmitResult | 'pending' | 'unreadable'> => {
        try {
          const r = (await request({ command: 'tx', transaction: hash })).result
          if (!r.validated) return 'pending'
          let engineResult = String(r.meta?.TransactionResult ?? 'unknown')
          if (engineResult === 'tesSUCCESS' && !(await innersApplied())) engineResult = BATCH_INNER_FAILED
          return { validated: engineResult === 'tesSUCCESS', engineResult, hash, ledgerIndex: Number(r.ledger_index), meta: r.meta }
        } catch (e) {
          if (errCode(e) === 'txnNotFound') return 'pending'
          log(`[xrpl ${network}] tx ${hash}: ${String((e as Error).message)}`)
          return 'unreadable'
        }
      }
      const unknown: SubmitResult = { validated: false, engineResult: OUTCOME_UNKNOWN, hash }
      for (;;) {
        await sleep(pollMs)
        const look = await check()
        if (typeof look === 'object') return look
        // The index is read after the lookup: not found once a later ledger is past LastLedgerSequence means never applied.
        const current = lls != null ? await ledgerIndex().catch(() => null) : null
        const passed = lls != null ? current != null && current > lls : Date.now() - started > 120_000
        if (passed) {
          for (let i = 0; i < FINAL_READS; i++) {
            const last = await check()
            if (typeof last === 'object') return last
            if (last === 'pending') return { validated: false, engineResult: /^ter/.test(prelim) && prelim !== 'terQUEUED' ? prelim : 'tefMAX_LEDGER', hash }
            await sleep(pollMs)
          }
          return unknown
        }
        if (Date.now() - started > maxWaitMs) return unknown
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
