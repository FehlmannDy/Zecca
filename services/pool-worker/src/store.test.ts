import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryPoolStore, createSqlitePoolStore, type PoolStore } from './store'

const H1 = 'A'.repeat(64)
const H2 = 'B'.repeat(64)
const tmpDb = () => join(mkdtempSync(join(tmpdir(), 'pool-store-')), 'nested', 'pool.sqlite')

const suites: [string, () => PoolStore][] = [
  ['memory', () => createMemoryPoolStore()],
  ['sqlite', () => createSqlitePoolStore(tmpDb())],
]

for (const [name, make] of suites) {
  describe(`${name} pool store`, () => {
    it('stores expected deposits and lists the pending ones', () => {
      const s = make()
      s.putDeposit({ intentId: 'i1', txHash: H1, from: 'rA', amountMinor: 500, status: 'pending' })
      s.putDeposit({ intentId: 'i2', txHash: H2, from: 'rB', amountMinor: 700, status: 'pending' })
      s.putDeposit({ intentId: 'i2', txHash: H2, from: 'rB', amountMinor: 700, status: 'failed', code: 'amount_mismatch' })
      expect(s.getDeposit(H1)).toEqual({ intentId: 'i1', txHash: H1, from: 'rA', amountMinor: 500, status: 'pending' })
      expect(s.getDeposit(H2)?.status).toBe('failed')
      expect(s.getDeposit('C'.repeat(64))).toBeUndefined()
      expect(s.pendingDeposits().map((d) => d.intentId)).toEqual(['i1'])
      s.close()
    })

    it('credits a deposit hash once', () => {
      const s = make()
      expect(s.isCredited(H1)).toBe(false)
      expect(s.markCredited(H1)).toBe(true)
      expect(s.markCredited(H1)).toBe(false)
      expect(s.isCredited(H1)).toBe(true)
      s.close()
    })

    it('stores payouts per intent and mints per reference', () => {
      const s = make()
      s.putPayout({ intentId: 'i1', to: 'rM', amountMinor: 995, status: 'reserved', reservedSequence: 12, lastLedgerSequence: 40 })
      expect(s.getPayout('i1')).toEqual({ intentId: 'i1', to: 'rM', amountMinor: 995, status: 'reserved', reservedSequence: 12, lastLedgerSequence: 40 })
      s.putPayout({ ...s.getPayout('i1')!, status: 'sent', txHash: H1 })
      expect(s.getPayout('i1')?.txHash).toBe(H1)
      expect(s.payouts().length).toBe(1)
      expect(s.getPayout('nope')).toBeUndefined()
      s.putMint({ reference: 'ref1', amountMinor: 2500, status: 'paying' })
      s.putMint({ reference: 'ref1', amountMinor: 2500, status: 'paid', paymentHash: H2 })
      expect(s.getMint('ref1')).toEqual({ reference: 'ref1', amountMinor: 2500, status: 'paid', paymentHash: H2 })
      expect(s.getMint('ref2')).toBeUndefined()
      s.close()
    })

    it('returns copies, not live references', () => {
      const s = make()
      s.putPayout({ intentId: 'i1', to: 'rM', amountMinor: 1, status: 'reserved', reservedSequence: 1, lastLedgerSequence: 2 })
      const p = s.getPayout('i1')!
      p.status = 'sent'
      expect(s.getPayout('i1')?.status).toBe('reserved')
      s.close()
    })
  })
}

describe('sqlite pool store persistence', () => {
  it('keeps everything across a reopen (process restart)', () => {
    const path = tmpDb()
    const a = createSqlitePoolStore(path)
    a.putDeposit({ intentId: 'i1', txHash: H1, from: 'rA', amountMinor: 500, status: 'pending' })
    a.markCredited(H2)
    a.putPayout({ intentId: 'i1', to: 'rM', amountMinor: 995, status: 'reserved', reservedSequence: 12, lastLedgerSequence: 40 })
    a.putMint({ reference: 'ref1', amountMinor: 2500, status: 'done', paymentHash: H1, convertHash: H2 })
    a.close()
    const b = createSqlitePoolStore(path)
    expect(b.pendingDeposits()).toEqual([{ intentId: 'i1', txHash: H1, from: 'rA', amountMinor: 500, status: 'pending' }])
    expect(b.isCredited(H2)).toBe(true)
    expect(b.markCredited(H2)).toBe(false)
    expect(b.getPayout('i1')?.reservedSequence).toBe(12)
    expect(b.getMint('ref1')?.status).toBe('done')
    b.close()
  })
})
