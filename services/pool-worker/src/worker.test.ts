import { describe, expect, it } from 'vitest'
import type { PoolEvent } from '@zecca/contracts'
import { createMemoryPoolStore, type PoolStore } from './store'
import { createPoolWorker, type PoolWorkerOptions } from './worker'
import { ADDR, createFakeLedger, fakeKeyStore, type FakeLedger } from './testing/fake-ledger'

const USER = 'rFakeUserAccount1111111111111'
const MERCHANT = 'rFakeMerchantAccount111111111'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(5)
  }
}

function setup(o: { ledger?: FakeLedger; store?: PoolStore; opts?: Partial<PoolWorkerOptions> } = {}) {
  const ledger = o.ledger ?? createFakeLedger()
  const store = o.store ?? createMemoryPoolStore()
  const keystore = fakeKeyStore()
  const logs: string[] = []
  const events: PoolEvent[] = []
  const worker = createPoolWorker({ ledger, keystore, store, log: (m) => logs.push(m), pollMs: 1e9, ledgerWaitMs: 5, lagMonitor: false, ...o.opts })
  for (const t of ['received', 'paidOut', 'failed'] as const) worker.on(t, (e) => events.push(e))
  const of = (type: PoolEvent['type']) => events.filter((e) => e.type === type)
  return { ledger, store, keystore, worker, logs, events, of }
}

describe('deposits', () => {
  it('matches a deposit to its intent by exact hash, decrypts it with the pool key, and emits received', async () => {
    const s = setup()
    await s.worker.start()
    const mine = s.ledger.t.deposit({ from: USER, amountMinor: 500 })
    const other = s.ledger.t.deposit({ from: USER, amountMinor: 500 }) // same sender, same amount, different hash
    s.worker.expectDeposit({ intentId: 'i1', txHash: mine.hash, from: USER, amountMinor: 500 })
    await waitFor(() => s.of('received').length === 1)
    await sleep(20)
    expect(s.of('received')).toEqual([{ type: 'received', intentId: 'i1', txHash: mine.hash, from: USER, amountMinor: 500 }])
    expect(s.store.isCredited(mine.hash)).toBe(true)
    expect(s.store.isCredited(other.hash)).toBe(false)
    const dec = s.ledger.t.calls.filter((c) => c.method === 'decryptAmount')
    expect(dec.length).toBe(1)
    expect(dec[0].args[1]).toBe('pool-priv')
    await s.worker.stop()
  })

  it('buffers a deposit seen before expectDeposit and matches it when expectDeposit arrives', async () => {
    const s = setup()
    await s.worker.start()
    const d = s.ledger.t.deposit({ from: USER, amountMinor: 1200 })
    await sleep(20)
    expect(s.events).toEqual([])
    expect(s.ledger.t.calls.some((c) => c.method === 'decryptAmount')).toBe(false) // unmatched deposits are never decrypted
    s.worker.expectDeposit({ intentId: 'i2', txHash: d.hash, from: USER, amountMinor: 1200 })
    await waitFor(() => s.of('received').length === 1)
    expect(s.of('received')[0]).toMatchObject({ intentId: 'i2', amountMinor: 1200 })
    await s.worker.stop()
  })

  it('looks the hash up on the ledger when the stream never delivered it', async () => {
    const s = setup()
    await s.worker.start()
    const d = s.ledger.t.deposit({ from: USER, amountMinor: 300, stream: false })
    s.worker.expectDeposit({ intentId: 'i3', txHash: d.hash.toLowerCase(), from: USER, amountMinor: 300 })
    await waitFor(() => s.of('received').length === 1)
    expect(s.of('received')[0]).toMatchObject({ intentId: 'i3', txHash: d.hash })
    expect(s.ledger.t.calls.some((c) => c.method === 'txByHash')).toBe(true)
    await s.worker.stop()
  })

  it('the account_tx poll picks up a deposit that both the stream and the lookup missed', async () => {
    const s = setup({ opts: { pollMs: 20 } })
    await s.worker.start()
    const d = s.ledger.t.deposit({ from: USER, amountMinor: 700, stream: false })
    s.ledger.t.throwNext('txByHash', 'connection lost')
    s.worker.expectDeposit({ intentId: 'i4', txHash: d.hash, from: USER, amountMinor: 700 })
    await waitFor(() => s.of('received').length === 1)
    expect(s.of('received')[0]).toMatchObject({ intentId: 'i4' })
    await s.worker.stop()
  })

  it('an amount mismatch fails the intent and never credits it', async () => {
    const s = setup()
    await s.worker.start()
    const d = s.ledger.t.deposit({ from: USER, amountMinor: 500, encryptedAmountMinor: 499 })
    s.worker.expectDeposit({ intentId: 'i5', txHash: d.hash, from: USER, amountMinor: 500 })
    await waitFor(() => s.of('failed').length === 1)
    s.ledger.t.redeliver(d)
    await sleep(20)
    expect(s.of('received')).toEqual([])
    expect(s.of('failed')).toEqual([expect.objectContaining({ type: 'failed', intentId: 'i5', stage: 'deposit', code: 'amount_mismatch', txHash: d.hash })])
    expect(s.store.isCredited(d.hash)).toBe(false)
    expect(s.store.getDeposit(d.hash)).toMatchObject({ status: 'failed', code: 'amount_mismatch' })
    await s.worker.stop()
  })

  it('an overpayment is a mismatch too (the amount must be equal)', async () => {
    const s = setup()
    await s.worker.start()
    const d = s.ledger.t.deposit({ from: USER, amountMinor: 500, encryptedAmountMinor: 501 })
    s.worker.expectDeposit({ intentId: 'i6', txHash: d.hash, from: USER, amountMinor: 500 })
    await waitFor(() => s.of('failed').length === 1)
    expect(s.of('failed')[0]).toMatchObject({ code: 'amount_mismatch' })
    await s.worker.stop()
  })

  it('a deposit from another sender than the intent payer fails', async () => {
    const s = setup()
    await s.worker.start()
    const d = s.ledger.t.deposit({ from: 'rSomebodyElse1111111111111111', amountMinor: 500 })
    s.worker.expectDeposit({ intentId: 'i7', txHash: d.hash, from: USER, amountMinor: 500 })
    await waitFor(() => s.of('failed').length === 1)
    expect(s.of('failed')[0]).toMatchObject({ stage: 'deposit', code: 'sender_mismatch' })
    await s.worker.stop()
  })

  it('a hash that is not a successful deposit of our token to the pool fails', async () => {
    const s = setup()
    await s.worker.start()
    const wrongToken = s.ledger.t.deposit({ from: USER, amountMinor: 500, issuanceId: 'FF'.repeat(24) })
    const failed = s.ledger.t.deposit({ from: USER, amountMinor: 500, engineResult: 'tecBAD_PROOF' })
    const elsewhere = s.ledger.t.deposit({ from: USER, amountMinor: 500, to: MERCHANT })
    s.worker.expectDeposit({ intentId: 'a', txHash: wrongToken.hash, from: USER, amountMinor: 500 })
    s.worker.expectDeposit({ intentId: 'b', txHash: failed.hash, from: USER, amountMinor: 500 })
    s.worker.expectDeposit({ intentId: 'c', txHash: elsewhere.hash, from: USER, amountMinor: 500 })
    await waitFor(() => s.of('failed').length === 3)
    expect(s.of('failed').map((e) => e.type === 'failed' && e.code)).toEqual(['not_a_deposit', 'not_a_deposit', 'not_a_deposit'])
    expect(s.of('received')).toEqual([])
    await s.worker.stop()
  })

  it('credits a deposit once: duplicate stream deliveries, the poll and a restart emit received once', async () => {
    const ledger = createFakeLedger()
    const store = createMemoryPoolStore()
    const s = setup({ ledger, store, opts: { pollMs: 15 } })
    await s.worker.start()
    const d = ledger.t.deposit({ from: USER, amountMinor: 900 })
    s.worker.expectDeposit({ intentId: 'i8', txHash: d.hash, from: USER, amountMinor: 900 })
    ledger.t.redeliver(d)
    ledger.t.redeliver(d)
    s.worker.expectDeposit({ intentId: 'i8', txHash: d.hash, from: USER, amountMinor: 900 })
    await sleep(80) // several polls
    expect(s.of('received').length).toBe(1)
    await s.worker.stop()
    const s2 = setup({ ledger, store }) // restart on the same store and ledger
    await s2.worker.start()
    s2.worker.expectDeposit({ intentId: 'i8', txHash: d.hash, from: USER, amountMinor: 900 })
    ledger.t.redeliver(d)
    await sleep(30)
    expect(s2.events).toEqual([])
    await s2.worker.stop()
  })

  it('on start, recovers an expected deposit that validated while the worker was down', async () => {
    const ledger = createFakeLedger()
    const store = createMemoryPoolStore()
    const d = ledger.t.deposit({ from: USER, amountMinor: 250, stream: false })
    store.putDeposit({ intentId: 'i9', txHash: d.hash, from: USER, amountMinor: 250, status: 'pending' })
    const s = setup({ ledger, store })
    await s.worker.start()
    await waitFor(() => s.of('received').length === 1)
    expect(s.of('received')[0]).toMatchObject({ intentId: 'i9' })
    await s.worker.stop()
  })

  it('a hash already claimed by one intent cannot be claimed by another', async () => {
    const s = setup()
    await s.worker.start()
    const d = s.ledger.t.deposit({ from: USER, amountMinor: 500 })
    s.worker.expectDeposit({ intentId: 'first', txHash: d.hash, from: USER, amountMinor: 500 })
    s.worker.expectDeposit({ intentId: 'second', txHash: d.hash, from: USER, amountMinor: 500 })
    await waitFor(() => s.of('received').length === 1)
    await sleep(20)
    expect(s.events.map((e) => e.intentId)).toEqual(['first'])
    await s.worker.stop()
  })
})

describe('payouts', () => {
  it('merges the pool inbox when spendable is short, then sends from the pool and emits paidOut', async () => {
    const s = setup()
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 100, inboxMinor: 1000 })
    await s.worker.start()
    const { hash } = await s.worker.payout({ intentId: 'p1', to: MERCHANT, amountMinor: 995 })
    expect(s.ledger.t.submits.map((x) => [x.role, x.tx.TransactionType])).toEqual([
      ['pool', 'ConfidentialMPTMergeInbox'],
      ['pool', 'ConfidentialMPTSend'],
    ])
    expect(s.ledger.t.calls.find((c) => c.method === 'buildSend')?.args[0]).toEqual({
      from: ADDR.pool,
      to: MERCHANT,
      amountMinor: 995,
      senderKey: { publicKey: 'pool-pub', privateKey: 'pool-priv' },
      sponsored: false,
    })
    expect(s.ledger.t.calls.find((c) => c.method === 'buildMergeInbox')?.args[0]).toEqual({ account: ADDR.pool, sponsored: false })
    expect(s.ledger.t.bal(MERCHANT).inboxMinor).toBe(995)
    expect(s.of('paidOut')).toEqual([{ type: 'paidOut', intentId: 'p1', txHash: hash, to: MERCHANT, amountMinor: 995 }])
    expect(s.store.getPayout('p1')).toMatchObject({ status: 'sent', txHash: hash })
    await s.worker.stop()
  })

  it('does not merge when the spendable part covers the payout', async () => {
    const s = setup()
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    await s.worker.payout({ intentId: 'p2', to: MERCHANT, amountMinor: 400 })
    expect(s.ledger.t.submits.map((x) => x.tx.TransactionType)).toEqual(['ConfidentialMPTSend'])
  })

  it('persists the reserved Sequence and LastLedgerSequence before submitting', async () => {
    const s = setup()
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    s.ledger.t.hangNextSubmit({ apply: false })
    void s.worker.payout({ intentId: 'p3', to: MERCHANT, amountMinor: 100 })
    await waitFor(() => s.ledger.t.submits.length === 1)
    const rec = s.store.getPayout('p3')!
    expect(rec.status).toBe('reserved')
    expect(rec.reservedSequence).toBe(s.ledger.t.submits[0].tx.Sequence)
    expect(rec.lastLedgerSequence).toBe(s.ledger.t.submits[0].tx.LastLedgerSequence)
    expect(rec.lastLedgerSequence).toBeGreaterThan(await s.ledger.ledgerIndex())
  })

  it('is sent once per intent: a second call returns the same hash without a new transaction', async () => {
    const s = setup()
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    const [a, b] = await Promise.all([s.worker.payout({ intentId: 'p4', to: MERCHANT, amountMinor: 100 }), s.worker.payout({ intentId: 'p4', to: MERCHANT, amountMinor: 100 })])
    const c = await s.worker.payout({ intentId: 'p4', to: MERCHANT, amountMinor: 100 })
    expect(a.hash).toBe(b.hash)
    expect(c.hash).toBe(a.hash)
    expect(s.ledger.t.submits.length).toBe(1)
    expect(s.of('paidOut').length).toBe(1)
  })

  it('refuses a second payout for the same intent with a different recipient or amount', async () => {
    const s = setup()
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    await s.worker.payout({ intentId: 'p5', to: MERCHANT, amountMinor: 100 })
    await expect(s.worker.payout({ intentId: 'p5', to: MERCHANT, amountMinor: 200 })).rejects.toThrow(/different/)
    expect(s.ledger.t.submits.length).toBe(1)
  })

  it('after a restart, finds the payout that landed on the ledger by its reserved sequence and never sends again', async () => {
    const ledger = createFakeLedger()
    const store = createMemoryPoolStore()
    ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    const s1 = setup({ ledger, store })
    ledger.t.hangNextSubmit({ apply: true }) // the tx validates but the process dies before it hears back
    void s1.worker.payout({ intentId: 'p6', to: MERCHANT, amountMinor: 300 })
    await waitFor(() => ledger.t.submits[0]?.result !== undefined)
    await s1.worker.stop()
    const landed = ledger.t.submits[0].result!.hash
    expect(store.getPayout('p6')?.status).toBe('reserved')

    const s2 = setup({ ledger, store })
    const { hash } = await s2.worker.payout({ intentId: 'p6', to: MERCHANT, amountMinor: 300 })
    expect(hash).toBe(landed)
    expect(ledger.t.submits.length).toBe(1)
    expect(ledger.t.bal(MERCHANT).inboxMinor).toBe(300)
    expect(s2.of('paidOut')).toEqual([{ type: 'paidOut', intentId: 'p6', txHash: landed, to: MERCHANT, amountMinor: 300 }])
    expect(store.getPayout('p6')).toMatchObject({ status: 'sent', txHash: landed })
  })

  it('start() confirms a reserved payout that landed while the worker was down', async () => {
    const ledger = createFakeLedger()
    const store = createMemoryPoolStore()
    ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    const s1 = setup({ ledger, store })
    ledger.t.hangNextSubmit({ apply: true })
    void s1.worker.payout({ intentId: 'p7', to: MERCHANT, amountMinor: 50 })
    await waitFor(() => ledger.t.submits[0]?.result !== undefined)
    await s1.worker.stop()
    const s2 = setup({ ledger, store })
    await s2.worker.start()
    await waitFor(() => s2.of('paidOut').length === 1)
    expect(s2.of('paidOut')[0]).toMatchObject({ intentId: 'p7', txHash: ledger.t.submits[0].result!.hash })
    await s2.worker.stop()
  })

  it('after a restart, waits for the LastLedgerSequence of a reserved payout that never landed, then sends it once', async () => {
    const ledger = createFakeLedger()
    const store = createMemoryPoolStore()
    ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    const s1 = setup({ ledger, store })
    ledger.t.hangNextSubmit({ apply: false }) // lost before reaching the ledger
    void s1.worker.payout({ intentId: 'p8', to: MERCHANT, amountMinor: 300 })
    await waitFor(() => ledger.t.submits.length === 1)
    await s1.worker.stop()
    const lls = store.getPayout('p8')!.lastLedgerSequence!

    const s2 = setup({ ledger, store })
    let done = false
    const p = s2.worker.payout({ intentId: 'p8', to: MERCHANT, amountMinor: 300 }).then((r) => ((done = true), r))
    await sleep(40)
    expect(done).toBe(false) // the lost tx could still validate until its LastLedgerSequence passes
    expect(ledger.t.submits.length).toBe(1)
    ledger.t.advance(lls - (await ledger.ledgerIndex()) + 2)
    const { hash } = await p
    expect(ledger.t.submits.length).toBe(2)
    expect(ledger.t.bal(MERCHANT).inboxMinor).toBe(300)
    expect(ledger.t.events.filter((e) => e.tx.Destination === MERCHANT && e.engineResult === 'tesSUCCESS').map((e) => e.hash)).toEqual([hash])
  })

  it('a reserved sequence consumed by another pool tx means the payout never went out: it is sent fresh', async () => {
    const ledger = createFakeLedger()
    const store = createMemoryPoolStore()
    ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    const s1 = setup({ ledger, store })
    ledger.t.hangNextSubmit({ apply: false })
    void s1.worker.payout({ intentId: 'p9', to: MERCHANT, amountMinor: 100 })
    await waitFor(() => ledger.t.submits.length === 1)
    await s1.worker.stop()
    const s2 = setup({ ledger, store })
    await s2.worker.payout({ intentId: 'other', to: USER, amountMinor: 10 }) // takes the reserved sequence
    await s2.worker.payout({ intentId: 'p9', to: MERCHANT, amountMinor: 100 })
    expect(ledger.t.bal(MERCHANT).inboxMinor).toBe(100)
    expect(s2.of('paidOut').map((e) => e.intentId)).toEqual(['other', 'p9'])
  })

  it('a reserved payout without a LastLedgerSequence and not on the ledger is left for a human, never resent', async () => {
    const store = createMemoryPoolStore()
    store.putPayout({ intentId: 'u1', to: MERCHANT, amountMinor: 100, status: 'reserved', reservedSequence: 1, lastLedgerSequence: null })
    const s = setup({ store })
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    await expect(s.worker.payout({ intentId: 'u1', to: MERCHANT, amountMinor: 100 })).rejects.toThrow(/by hand/)
    expect(s.ledger.t.submits).toEqual([])
    expect(s.of('failed')[0]).toMatchObject({ intentId: 'u1', stage: 'payout', code: 'payout_unknown' })
  })

  it('runs pool transactions strictly one at a time', async () => {
    const s = setup({ ledger: createFakeLedger({ submitDelayMs: 5 }) })
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 200, inboxMinor: 10_000 })
    const outs = await Promise.all([1, 2, 3, 4, 5].map((n) => s.worker.payout({ intentId: `s${n}`, to: MERCHANT, amountMinor: 100 * n })))
    await Promise.all([s.worker.mintIn(500, 'ref-serial'), s.worker.payout({ intentId: 's6', to: USER, amountMinor: 1 })])
    expect(new Set(outs.map((o) => o.hash)).size).toBe(5)
    expect(s.ledger.t.maxActive.get(ADDR.pool)).toBe(1)
    expect(s.ledger.t.submits.every((x) => x.result?.engineResult === 'tesSUCCESS')).toBe(true)
    expect(s.ledger.t.bal(MERCHANT).inboxMinor).toBe(1500)
  })

  it('an error emits failed stage payout, keeps the money in the pool and rejects', async () => {
    const s = setup()
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 100, inboxMinor: 100 })
    await expect(s.worker.payout({ intentId: 'f1', to: MERCHANT, amountMinor: 500 })).rejects.toThrow(/insufficient/)
    expect(s.of('failed')).toEqual([expect.objectContaining({ intentId: 'f1', stage: 'payout', code: 'insufficient_funds' })])
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 1000 })
    s.ledger.t.failNextSubmit('tecBAD_PROOF')
    await expect(s.worker.payout({ intentId: 'f2', to: MERCHANT, amountMinor: 500 })).rejects.toThrow(/tecBAD_PROOF/)
    expect(s.of('failed')[1]).toMatchObject({ intentId: 'f2', stage: 'payout', code: 'tecBAD_PROOF' })
    expect(s.ledger.t.bal(ADDR.pool).spendableMinor).toBe(1000)
    expect(s.logs.some((l) => l.includes('f2'))).toBe(true)
    // manual retry: the failed tx consumed its sequence without paying, so it is safe to send again
    const { hash } = await s.worker.payout({ intentId: 'f2', to: MERCHANT, amountMinor: 500 })
    expect(s.of('paidOut')).toEqual([expect.objectContaining({ intentId: 'f2', txHash: hash })])
    expect(s.ledger.t.bal(MERCHANT).inboxMinor).toBe(500)
  })

  it('refuses amounts that are not positive integers', async () => {
    const s = setup()
    await expect(s.worker.payout({ intentId: 'x', to: MERCHANT, amountMinor: 1.5 })).rejects.toThrow(/positive integer/)
    await expect(s.worker.mintIn(0, 'r')).rejects.toThrow(/positive integer/)
    expect(s.ledger.t.submits).toEqual([])
  })
})

describe('mint in (top-up, SPEC §2.7)', () => {
  it('issuer pays CMPT to the pool, the pool converts it, once per reference', async () => {
    const s = setup()
    const [a, b] = await Promise.all([s.worker.mintIn(2500, 'TESTNET-DELIVERY-1'), s.worker.mintIn(2500, 'TESTNET-DELIVERY-1')])
    const c = await s.worker.mintIn(2500, 'TESTNET-DELIVERY-1')
    expect(a.hash).toBe(b.hash)
    expect(c.hash).toBe(a.hash)
    expect(s.ledger.t.submits.map((x) => [x.role, x.tx.TransactionType])).toEqual([
      ['issuer', 'Payment'],
      ['pool', 'ConfidentialMPTConvert'],
    ])
    expect(s.ledger.t.submits[0].tx).toMatchObject({ Account: ADDR.issuer, Destination: ADDR.pool, Amount: { mpt_issuance_id: s.ledger.issuanceId, value: '2500' } })
    expect(s.ledger.t.calls.find((x) => x.method === 'buildConvert')?.args[0]).toEqual({ account: ADDR.pool, amountMinor: 2500, holderKey: { publicKey: 'pool-pub', privateKey: 'pool-priv' } })
    expect(s.ledger.t.bal(ADDR.pool)).toMatchObject({ publicMinor: 0, inboxMinor: 2500 })
    expect(s.store.getMint('TESTNET-DELIVERY-1')).toMatchObject({ status: 'done', convertHash: a.hash, paymentHash: s.ledger.t.submits[0].result!.hash })
  })

  it('an issuer payment the ledger refused (nothing applied) can be retried', async () => {
    const s = setup()
    s.ledger.t.failNextSubmit('tefPAST_SEQ')
    await expect(s.worker.mintIn(800, 'ref-2')).rejects.toThrow(/tefPAST_SEQ/)
    expect(s.store.getMint('ref-2')).toMatchObject({ status: 'failed' })
    await s.worker.mintIn(800, 'ref-2')
    expect(s.ledger.t.events.filter((e) => e.tx.TransactionType === 'Payment' && e.engineResult === 'tesSUCCESS').length).toBe(1)
    expect(s.ledger.t.events.filter((e) => e.tx.TransactionType === 'ConfidentialMPTConvert' && e.engineResult === 'tesSUCCESS').length).toBe(1)
  })

  it('a tec issuer payment is final even when reported as not validated (as the live client does), so it can be retried', async () => {
    const s = setup()
    const orig = s.ledger.submitAs
    let first = true
    s.ledger.submitAs = async (role, tx) => {
      if (first && tx.TransactionType === 'Payment') {
        first = false
        return { validated: false, engineResult: 'tecNO_AUTH', hash: 'E'.repeat(64) }
      }
      return orig(role, tx)
    }
    await expect(s.worker.mintIn(800, 'ref-7')).rejects.toThrow(/tecNO_AUTH/)
    expect(s.store.getMint('ref-7')).toMatchObject({ status: 'failed' })
    await s.worker.mintIn(800, 'ref-7')
    expect(s.ledger.t.bal(ADDR.pool).inboxMinor).toBe(800)
  })

  it('an issuer payment with an unknown outcome is left for a human, never resent', async () => {
    const s = setup()
    s.ledger.t.throwNextSubmit('socket hang up')
    await expect(s.worker.mintIn(800, 'ref-5')).rejects.toThrow(/socket hang up/)
    await expect(s.worker.mintIn(800, 'ref-5')).rejects.toThrow(/by hand/)
    expect(s.ledger.t.submits.length).toBe(1)
  })

  it('a convert that fails after the payment is retried without a second payment', async () => {
    const s = setup()
    s.ledger.t.failNextSubmit('tecINSUFFICIENT_FUNDS', 'ConfidentialMPTConvert')
    await expect(s.worker.mintIn(800, 'ref-3')).rejects.toThrow(/tecINSUFFICIENT_FUNDS/)
    expect(s.store.getMint('ref-3')).toMatchObject({ status: 'failed' })
    await s.worker.mintIn(800, 'ref-3')
    expect(s.ledger.t.events.filter((e) => e.tx.TransactionType === 'Payment').length).toBe(1)
    expect(s.ledger.t.events.filter((e) => e.tx.TransactionType === 'ConfidentialMPTConvert' && e.engineResult === 'tesSUCCESS').length).toBe(1)
    expect(s.ledger.t.bal(ADDR.pool).inboxMinor).toBe(800)
  })

  it('after a restart mid-convert, finds the convert on the ledger instead of converting twice', async () => {
    const ledger = createFakeLedger()
    const store = createMemoryPoolStore()
    const s1 = setup({ ledger, store })
    ledger.t.hangNextSubmit({ apply: true }, 'ConfidentialMPTConvert')
    void s1.worker.mintIn(600, 'ref-6')
    await waitFor(() => ledger.t.submits[1]?.result !== undefined)
    expect(store.getMint('ref-6')?.status).toBe('converting')
    const s2 = setup({ ledger, store })
    const { hash } = await s2.worker.mintIn(600, 'ref-6')
    expect(hash).toBe(ledger.t.submits[1].result!.hash)
    expect(ledger.t.submits.length).toBe(2)
    expect(ledger.t.bal(ADDR.pool).inboxMinor).toBe(600)
  })

  it('does not pay again when a payment may have been sent before a restart', async () => {
    const store = createMemoryPoolStore()
    store.putMint({ reference: 'ref-4', amountMinor: 100, status: 'paying' })
    const s = setup({ store })
    await expect(s.worker.mintIn(100, 'ref-4')).rejects.toThrow(/by hand/)
    expect(s.ledger.t.submits).toEqual([])
  })
})

describe('merge inbox for a user (SPEC §2.5)', () => {
  it('builds a delegated MergeInbox on the user account and submits it as the relayer', async () => {
    const s = setup()
    const { hash } = await s.worker.mergeInboxFor(MERCHANT)
    expect(s.ledger.t.calls.find((c) => c.method === 'buildMergeInbox')?.args[0]).toEqual({ account: MERCHANT, sponsored: false, delegate: ADDR.relayer })
    expect(s.ledger.t.submits.map((x) => [x.role, x.tx.TransactionType, x.tx.Account, x.tx.Delegate])).toEqual([['relayer', 'ConfidentialMPTMergeInbox', MERCHANT, ADDR.relayer]])
    expect(hash).toBe(s.ledger.t.submits[0].result!.hash)
  })

  it('rejects when the ledger refuses the merge', async () => {
    const s = setup()
    s.ledger.t.failNextSubmit('tecNO_DELEGATE_PERMISSION')
    await expect(s.worker.mergeInboxFor(MERCHANT)).rejects.toThrow(/tecNO_DELEGATE_PERMISSION/)
    expect(s.logs.some((l) => l.includes('tecNO_DELEGATE_PERMISSION'))).toBe(true)
  })

  it('merges for one account one at a time', async () => {
    const s = setup({ ledger: createFakeLedger({ submitDelayMs: 5 }) })
    await Promise.all([s.worker.mergeInboxFor(MERCHANT), s.worker.mergeInboxFor(MERCHANT), s.worker.mergeInboxFor(USER)])
    expect(s.ledger.t.maxActive.get(MERCHANT)).toBe(1)
    expect(s.ledger.t.submits.every((x) => x.result?.engineResult === 'tesSUCCESS')).toBe(true)
  })
})

describe('status and lifecycle', () => {
  it('reports the pool balance from the last read and the queue length', async () => {
    const s = setup({ ledger: createFakeLedger({ submitDelayMs: 20 }) })
    expect(s.worker.status()).toEqual({ spendableMinor: 0, inboxMinor: 0, queue: 0 })
    s.ledger.t.setBal(ADDR.pool, { spendableMinor: 1000, inboxMinor: 50 })
    const a = s.worker.payout({ intentId: 'q1', to: MERCHANT, amountMinor: 100 })
    const b = s.worker.payout({ intentId: 'q2', to: MERCHANT, amountMinor: 100 })
    expect(s.worker.status().queue).toBe(2)
    await Promise.all([a, b])
    expect(s.worker.status()).toEqual({ spendableMinor: 800, inboxMinor: 50, queue: 0 })
  })

  it('stop() unsubscribes from the pool account and stops polling', async () => {
    const s = setup({ opts: { pollMs: 10 } })
    await s.worker.start()
    expect(s.ledger.t.watchers()).toBe(1)
    await s.worker.stop()
    expect(s.ledger.t.watchers()).toBe(0)
    const n = s.ledger.t.calls.filter((c) => c.method === 'accountTx').length
    await sleep(40)
    expect(s.ledger.t.calls.filter((c) => c.method === 'accountTx').length).toBe(n)
  })

  it('a listener that throws does not break the worker', async () => {
    const s = setup()
    s.worker.on('received', () => {
      throw new Error('listener bug')
    })
    await s.worker.start()
    const d = s.ledger.t.deposit({ from: USER, amountMinor: 10 })
    s.worker.expectDeposit({ intentId: 'l1', txHash: d.hash, from: USER, amountMinor: 10 })
    await waitFor(() => s.of('received').length === 1)
    expect(s.logs.some((l) => l.includes('listener bug'))).toBe(true)
    await s.worker.stop()
  })
})
