// The pool worker (SPEC §2.5–2.7, §4.4). Port of card-issuer/src/xrpl-pool.js, generalised from card deposits to intents:
//  - watches the pool (stream + account_tx safety poll), matches each deposit to its intent by exact hash,
//    decrypts it with the pool's ElGamal key and checks the amount EQUALS the intent amount before anything is credited;
//  - pays out, strictly one pool transaction at a time, once per intent (Sequence reserved and persisted before the submit,
//    looked up on the ledger before ever sending again);
//  - mints top-ups into the pool (issuer Payment + pool Convert), once per reference;
//  - merges users' inboxes through the relayer's delegated permission.
// Every ledger write goes through the Ledger interface. Never logs a secret.
import type { ConfidentialBalance, KeyStore, Ledger, LedgerTxEvent, PoolEvent, PoolWorker, UnsignedTx } from '@zecca/contracts'
import { startLagMonitor } from './lag'
import { createKeyedQueues, createSerialQueue } from './queue'
import type { ExpectedDeposit, MintRecord, PayoutRecord, PoolStore } from './store'

export type PoolWorkerOptions = {
  ledger: Ledger
  keystore: KeyStore
  store: PoolStore
  log?: (m: string) => void
  /** Milliseconds; used for durations in logs. */
  clock?: () => number
  /** account_tx safety poll (the account stream is primary). Default 15 s. */
  pollMs?: number
  /** While a reserved pool tx might still validate, how often to re-check the ledger. Default 4 s. */
  ledgerWaitMs?: number
  /** [lag] monitor, on by default. */
  lagMonitor?: boolean
}

/** Ledgers a pool tx may take before it is final (when the builder set no LastLedgerSequence). Not part of any proof context. */
const POOL_LLS_WINDOW = 20
const POLL_LIMIT = 50
const RECOVERY_LIMIT = 200
const BUFFER_MAX = 500

export class PoolError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'PoolError'
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function assertPositiveInt(n: number, what: string) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new PoolError('invalid_amount', `${what}: amount must be a positive integer of minor units, got ${n}`)
}

type Reconciled = { kind: 'found'; hash: string } | { kind: 'free' } | { kind: 'unknown'; why: string }

/** The fresh ciphertext of a pool tx (ElGamal randomness): unique per build, so it tells our tx from any other on the same sequence. */
const FINGERPRINT_FIELD: Record<string, string> = { ConfidentialMPTSend: 'DestinationEncryptedAmount', ConfidentialMPTConvert: 'HolderEncryptedAmount' }
function fingerprintOf(tx: Record<string, unknown>): string | undefined {
  const field = FINGERPRINT_FIELD[String(tx.TransactionType)]
  const v = field ? tx[field] : undefined
  return typeof v === 'string' && v ? `${String(tx.TransactionType)}:${v.toUpperCase()}` : undefined
}

/**
 * A result after which the tx can never apply and paid nothing: tec (validated, sequence used, nothing moved) or a tem/tef/tel refusal.
 * Not tefMAX_LEDGER: the live client also reports it when its last status check failed, so the tx may still have validated.
 */
const isFinalFailure = (code: string) => /^(tec|tem|tef|tel)/.test(code) && code !== 'tefMAX_LEDGER'

export function createPoolWorker(o: PoolWorkerOptions): PoolWorker {
  const { ledger, keystore, store } = o
  const log = o.log ?? ((m: string) => console.log(m))
  const clock = o.clock ?? Date.now
  const pollMs = o.pollMs ?? 15_000
  const ledgerWaitMs = o.ledgerWaitMs ?? 4_000
  const pool = keystore.getWallet('pool').address
  const poolKey = () => keystore.getElGamal('pool')
  const issuance = ledger.issuanceId.toUpperCase()

  const poolQ = createSerialQueue()
  const mergeQ = createKeyedQueues()
  const listeners = { received: new Set<(e: PoolEvent) => void>(), paidOut: new Set<(e: PoolEvent) => void>(), failed: new Set<(e: PoolEvent) => void>() }
  let balance: ConfidentialBalance = { spendableMinor: 0, inboxMinor: 0 }
  let started = false
  let unwatch: (() => void) | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let stopLag: (() => void) | undefined

  function emit(e: PoolEvent) {
    for (const cb of listeners[e.type]) {
      try {
        cb(e)
      } catch (err) {
        log(`[pool] ${e.type} listener failed: ${msg(err)}`)
      }
    }
  }

  // ---------- deposits ----------
  const buffered = new Map<string, LedgerTxEvent>() // deposits seen before expectDeposit (the API calls it after its own submit returns)
  const inflight = new Set<string>()

  const isDeposit = (e: LedgerTxEvent) =>
    e.validated &&
    e.engineResult === 'tesSUCCESS' &&
    e.tx.TransactionType === 'ConfidentialMPTSend' &&
    e.tx.Destination === pool &&
    e.tx.Account !== pool &&
    String(e.tx.MPTokenIssuanceID ?? '').toUpperCase() === issuance

  function buffer(hash: string, e: LedgerTxEvent) {
    buffered.set(hash, e)
    if (buffered.size > BUFFER_MAX) buffered.delete(buffered.keys().next().value!)
  }

  async function onTx(e: LedgerTxEvent): Promise<void> {
    if (!e.validated || !e.hash) return
    const hash = e.hash.toUpperCase()
    if (store.isCredited(hash)) return
    const exp = store.getDeposit(hash)
    if (!exp) {
      if (isDeposit(e)) buffer(hash, e)
      return
    }
    if (exp.status === 'pending') await verify(hash, e)
  }

  function failDeposit(d: ExpectedDeposit, code: string, message: string) {
    store.putDeposit({ ...d, status: 'failed', code })
    buffered.delete(d.txHash)
    log(`[pool] deposit ${d.txHash} for intent ${d.intentId} failed (${code}): ${message}`)
    emit({ type: 'failed', intentId: d.intentId, stage: 'deposit', code, message, txHash: d.txHash })
  }

  async function verify(hash: string, e: LedgerTxEvent): Promise<void> {
    if (inflight.has(hash)) return
    inflight.add(hash)
    try {
      const d = store.getDeposit(hash)
      if (!d || d.status !== 'pending' || store.isCredited(hash)) return
      if (!isDeposit(e)) return failDeposit(d, 'not_a_deposit', `transaction ${hash} is not a successful deposit of the token to the pool`)
      if (e.tx.Account !== d.from) return failDeposit(d, 'sender_mismatch', `deposit ${hash} comes from ${String(e.tx.Account)}, the intent payer is ${d.from}`)
      let amount: number
      try {
        amount = await ledger.decryptAmount(String(e.tx.DestinationEncryptedAmount), poolKey().privateKey)
      } catch (err) {
        return failDeposit(d, 'decrypt_failed', `deposit ${hash} could not be decrypted with the pool key: ${msg(err)}`)
      }
      if (amount !== d.amountMinor) return failDeposit(d, 'amount_mismatch', `deposit ${hash} carries ${amount}, the intent expects ${d.amountMinor}`)
      if (!store.markCredited(hash)) return
      store.putDeposit({ ...d, status: 'received' })
      buffered.delete(hash)
      balance = { ...balance, inboxMinor: balance.inboxMinor + amount }
      log(`[pool] received ${amount} for intent ${d.intentId} tx=${hash}`)
      emit({ type: 'received', intentId: d.intentId, txHash: hash, from: d.from, amountMinor: amount })
    } finally {
      inflight.delete(hash)
    }
  }

  const handle = (e: LedgerTxEvent) => void onTx(e).catch((err) => log(`[pool] tx ${e.hash} not processed: ${msg(err)}`))

  let polling = false
  async function poll(limit: number) {
    if (polling) return
    polling = true
    try {
      const txs = await ledger.accountTx(pool, limit)
      for (const e of [...txs].reverse()) await onTx(e) // oldest first
    } catch (err) {
      log(`[pool] account_tx poll failed: ${msg(err)}`)
    } finally {
      polling = false
    }
  }

  function lookUp(hash: string) {
    const cached = buffered.get(hash)
    if (cached) return handle(cached)
    ledger
      .txByHash(hash)
      .then((e) => e && handle(e))
      .catch((err) => log(`[pool] lookup of deposit ${hash} failed: ${msg(err)} (the poll will retry)`))
  }

  // ---------- pool transactions ----------
  const withLastLedger = async (tx: UnsignedTx) => {
    if (tx.LastLedgerSequence === undefined || tx.LastLedgerSequence === null) tx.LastLedgerSequence = (await ledger.ledgerIndex()) + POOL_LLS_WINDOW
    return tx
  }

  /**
   * What happened to the pool tx reserved at `seq` (identified by its fingerprint)? found: that very tx validated with tesSUCCESS.
   * free: the sequence was used by another tx, or ours failed, or it expired unvalidated, so it paid nothing and never will.
   * unknown: cannot tell (manual). Waits while the reserved tx could still validate (ledger index not past its LastLedgerSequence).
   */
  async function reconcile(seq: number, lls: number | null, fingerprint: string | undefined, wait = true): Promise<Reconciled> {
    for (;;) {
      const idx = await ledger.ledgerIndex()
      const own = (await ledger.accountTx(pool, RECOVERY_LIMIT)).filter((e) => e.validated && e.tx.Account === pool)
      const hit = own.find((e) => Number(e.tx.Sequence) === seq)
      if (hit) {
        if (hit.engineResult !== 'tesSUCCESS') return { kind: 'free' }
        if (!fingerprint) return { kind: 'unknown', why: `sequence ${seq} was used by ${hit.hash} and no fingerprint was recorded to tell whether it is this transaction` }
        return fingerprintOf(hit.tx) === fingerprint ? { kind: 'found', hash: hit.hash.toUpperCase() } : { kind: 'free' }
      }
      if (own.some((e) => Number(e.tx.Sequence) > seq)) return { kind: 'unknown', why: `sequence ${seq} is older than the last ${own.length} pool transactions` }
      if (lls === null) return { kind: 'unknown', why: `no LastLedgerSequence was recorded for sequence ${seq}` }
      if (idx > lls + 1) return { kind: 'free' }
      if (!wait) return { kind: 'unknown', why: `sequence ${seq} may still validate until ledger ${lls}` }
      await sleep(ledgerWaitMs)
    }
  }

  async function readBalance() {
    balance = await ledger.confidentialBalance(pool, poolKey())
    return balance
  }

  async function ensureSpendable(amount: number) {
    const b = await readBalance()
    if (b.spendableMinor >= amount) return
    if (b.spendableMinor + b.inboxMinor < amount) throw new PoolError('insufficient_funds', `the pool holds ${b.spendableMinor + b.inboxMinor}, the payout needs ${amount} (insufficient funds)`)
    const r = await ledger.submitAs('pool', await ledger.buildMergeInbox({ account: pool, sponsored: false }))
    if (r.engineResult !== 'tesSUCCESS') throw new PoolError('merge_failed', `pool MergeInbox: ${r.engineResult} tx=${r.hash}`)
    balance = { spendableMinor: b.spendableMinor + b.inboxMinor, inboxMinor: 0 }
  }

  /** The reserved tx can never apply: drop the reservation, so a retry sends fresh without looking the old sequence up again. */
  function releasePayout(rec: PayoutRecord): PayoutRecord {
    const { fingerprint: _f, ...rest } = rec
    const released = { ...rest, reservedSequence: null, lastLedgerSequence: null }
    store.putPayout(released)
    return released
  }

  function confirmPayout(rec: PayoutRecord, hash: string): string {
    const { error: _e, ...rest } = rec
    store.putPayout({ ...rest, status: 'sent', txHash: hash })
    emit({ type: 'paidOut', intentId: rec.intentId, txHash: hash, to: rec.to, amountMinor: rec.amountMinor })
    return hash
  }

  async function doPayout(i: { intentId: string; to: string; amountMinor: number }): Promise<{ hash: string }> {
    assertPositiveInt(i.amountMinor, `payout for intent ${i.intentId}`)
    const prev = store.getPayout(i.intentId)
    if (prev && (prev.to !== i.to || prev.amountMinor !== i.amountMinor))
      throw new PoolError('payout_conflict', `intent ${i.intentId} already has a payout of ${prev.amountMinor} to ${prev.to}; refusing a different one`)
    if (prev?.status === 'sent' && prev.txHash) return { hash: prev.txHash }
    const t0 = clock()
    try {
      if (prev && prev.reservedSequence !== null) {
        const r = await reconcile(prev.reservedSequence, prev.lastLedgerSequence, prev.fingerprint)
        if (r.kind === 'found') {
          log(`[pool] payout for intent ${i.intentId} had already landed tx=${r.hash}`)
          return { hash: confirmPayout(prev, r.hash) }
        }
        if (r.kind === 'unknown') throw new PoolError('payout_unknown', `intent ${i.intentId}: ${r.why}; check the pool's transactions by hand before paying again`)
        releasePayout(prev)
      }
      await ensureSpendable(i.amountMinor)
      const tx = await withLastLedger(await ledger.buildSend({ from: pool, to: i.to, amountMinor: i.amountMinor, senderKey: poolKey(), sponsored: false }))
      const rec: PayoutRecord = {
        intentId: i.intentId,
        to: i.to,
        amountMinor: i.amountMinor,
        status: 'reserved',
        reservedSequence: Number(tx.Sequence),
        lastLedgerSequence: Number(tx.LastLedgerSequence),
        fingerprint: fingerprintOf(tx),
      }
      store.putPayout(rec) // before the submit: a restart looks this sequence up before ever sending again
      const res = await ledger.submitAs('pool', tx)
      if (res.engineResult !== 'tesSUCCESS') {
        if (isFinalFailure(res.engineResult)) releasePayout(rec)
        throw new PoolError(res.engineResult, `pool send for intent ${i.intentId}: ${res.engineResult} tx=${res.hash}`)
      }
      balance = { ...balance, spendableMinor: Math.max(0, balance.spendableMinor - i.amountMinor) }
      const hash = confirmPayout(rec, res.hash)
      log(`[pool] paid out ${i.amountMinor} for intent ${i.intentId} in ${clock() - t0} ms tx=${hash}`)
      return { hash }
    } catch (err) {
      const code = err instanceof PoolError ? err.code : 'payout_error'
      const cur = store.getPayout(i.intentId) ?? { intentId: i.intentId, to: i.to, amountMinor: i.amountMinor, status: 'failed' as const, reservedSequence: null, lastLedgerSequence: null }
      store.putPayout({ ...cur, status: 'failed', error: `${code}: ${msg(err)}` })
      log(`[pool] payout for intent ${i.intentId} failed (${code}): ${msg(err)}. The money stays in the pool; retry is manual.`)
      emit({ type: 'failed', intentId: i.intentId, stage: 'payout', code, message: msg(err) })
      throw err
    }
  }

  async function reconcileReservedPayouts() {
    for (const p of store.payouts()) {
      if (p.status === 'sent' || p.reservedSequence === null) continue
      const r = await reconcile(p.reservedSequence, p.lastLedgerSequence, p.fingerprint, false)
      if (r.kind === 'found') {
        log(`[pool] payout for intent ${p.intentId} landed while the worker was down tx=${r.hash}`)
        confirmPayout(p, r.hash)
      }
    }
  }

  async function doMint(amount: number, reference: string): Promise<{ hash: string }> {
    assertPositiveInt(amount, `mint ${reference}`)
    if (!reference) throw new PoolError('invalid_reference', 'mintIn: a reference is required')
    let m: MintRecord | undefined = store.getMint(reference)
    if (m && m.amountMinor !== amount) throw new PoolError('mint_conflict', `mint ${reference} is recorded for ${m.amountMinor}; refusing a different amount (${amount})`)
    if (m?.status === 'done' && m.convertHash) return { hash: m.convertHash }
    if (m?.status === 'paying')
      throw new PoolError('mint_unknown', `mint ${reference}: the issuer payment may have reached the ledger before a restart; check the issuer's transactions and fix the record by hand`)
    if (!m?.paymentHash) {
      m = { reference, amountMinor: amount, status: 'paying' }
      store.putMint(m) // an unknown outcome stays 'paying' and is never resent automatically: no unbacked supply
      const pay: UnsignedTx = { TransactionType: 'Payment', Account: keystore.getWallet('issuer').address, Destination: pool, Amount: { mpt_issuance_id: ledger.issuanceId, value: String(amount) } }
      const r = await ledger.submitAs('issuer', pay)
      if (r.engineResult !== 'tesSUCCESS') {
        // Final, nothing moved: a tec (validated with a failure; the live client reports it as validated: false) or a tef/tem/tel.
        if (r.validated || isFinalFailure(r.engineResult)) store.putMint({ ...m, status: 'failed', error: r.engineResult })
        throw new PoolError(r.engineResult, `issuer payment for mint ${reference}: ${r.engineResult} tx=${r.hash}`)
      }
      m = { ...m, status: 'paid', paymentHash: r.hash }
      store.putMint(m)
    }
    if (m.convertSequence !== undefined && m.convertSequence !== null) {
      const r = await reconcile(m.convertSequence, m.convertLastLedgerSequence ?? null, m.convertFingerprint)
      if (r.kind === 'found') {
        store.putMint({ ...m, status: 'done', convertHash: r.hash })
        return { hash: r.hash }
      }
      if (r.kind === 'unknown') throw new PoolError('mint_unknown', `mint ${reference}: ${r.why}; check the pool's transactions by hand`)
    }
    const tx = await withLastLedger(await ledger.buildConvert({ account: pool, amountMinor: amount, holderKey: poolKey() }))
    m = { ...m, status: 'converting', convertSequence: Number(tx.Sequence), convertLastLedgerSequence: Number(tx.LastLedgerSequence), convertFingerprint: fingerprintOf(tx) }
    store.putMint(m)
    const r = await ledger.submitAs('pool', tx)
    if (r.engineResult !== 'tesSUCCESS') {
      const { convertFingerprint: _f, ...rest } = m
      // A final refusal frees the sequence (the retry converts fresh); otherwise the retry looks the reserved sequence up first.
      store.putMint(isFinalFailure(r.engineResult) ? { ...rest, status: 'failed', error: r.engineResult, convertSequence: null, convertLastLedgerSequence: null } : { ...m, status: 'failed', error: r.engineResult })
      throw new PoolError(r.engineResult, `pool convert for mint ${reference}: ${r.engineResult} tx=${r.hash}`)
    }
    store.putMint({ ...m, status: 'done', convertHash: r.hash })
    balance = { ...balance, inboxMinor: balance.inboxMinor + amount }
    log(`[pool] minted ${amount} into the pool for ${reference} payment=${m.paymentHash} convert=${r.hash}`)
    return { hash: r.hash }
  }

  async function doMerge(address: string): Promise<{ hash: string }> {
    try {
      const tx = await ledger.buildMergeInbox({ account: address, sponsored: false, delegate: keystore.getWallet('relayer').address })
      const r = await ledger.submitAs('relayer', tx)
      if (r.engineResult !== 'tesSUCCESS') throw new PoolError(r.engineResult, `merge inbox of ${address} via the relayer: ${r.engineResult} tx=${r.hash}`)
      return { hash: r.hash }
    } catch (err) {
      log(`[pool] ${msg(err)}`)
      throw err
    }
  }

  return {
    async start() {
      if (started) return
      started = true
      unwatch = ledger.watchAccount(pool, handle)
      if (o.lagMonitor !== false) stopLag = startLagMonitor({ log })
      await poll(RECOVERY_LIMIT)
      for (const d of store.pendingDeposits()) {
        try {
          const e = await ledger.txByHash(d.txHash)
          if (e) await onTx(e)
        } catch (err) {
          log(`[pool] recovery lookup of deposit ${d.txHash} failed: ${msg(err)}`)
        }
      }
      await poolQ.run(reconcileReservedPayouts).catch((err) => log(`[pool] payout recovery failed: ${msg(err)}`))
      pollTimer = setInterval(() => void poll(POLL_LIMIT), pollMs)
      pollTimer.unref?.()
      log(`[pool] watching ${pool}`)
    },

    expectDeposit(i) {
      const hash = i.txHash.toUpperCase()
      const prev = store.getDeposit(hash)
      if (prev && prev.intentId !== i.intentId) {
        log(`[pool] deposit ${hash} already belongs to intent ${prev.intentId}; ignored for intent ${i.intentId}`)
        return
      }
      if (prev && prev.status !== 'pending') return
      if (!prev) store.putDeposit({ intentId: i.intentId, txHash: hash, from: i.from, amountMinor: i.amountMinor, status: 'pending' })
      lookUp(hash)
    },

    on(event, cb) {
      listeners[event].add(cb)
    },

    payout: (i) => poolQ.run(() => doPayout(i)),
    mintIn: (amountMinor, reference) => poolQ.run(() => doMint(amountMinor, reference)),
    mergeInboxFor: (address) => mergeQ.run(address, () => doMerge(address)),

    status: () => ({ spendableMinor: balance.spendableMinor, inboxMinor: balance.inboxMinor, queue: poolQ.length + mergeQ.length }),

    async stop() {
      unwatch?.()
      unwatch = undefined
      if (pollTimer) clearInterval(pollTimer)
      pollTimer = undefined
      stopLag?.()
      stopLag = undefined
      started = false
    },
  }
}
