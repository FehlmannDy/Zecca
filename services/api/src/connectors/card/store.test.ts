// The card sub-ledger (port of card-issuer/test/store.test.js and the pool half of pool.test.js), on the API's SQLite.
import { describe, expect, it } from 'vitest'
import { openDb } from '../../db'
import { cardStore, DECLINE_COPY, toAuthorization } from './store'

const fresh = () => {
  const db = openDb(':memory:')
  let t = Date.parse('2026-11-21T09:00:00.000Z')
  const ctx = { db, iso: () => new Date((t += 1000)).toISOString() }
  return { db, ctx, store: cardStore(ctx) }
}
const card = { id: 'card_01', token: 'card_tok', last4: '4417', expMonth: 11, expYear: 2029, state: 'OPEN' as const, holderName: 'Ana Ferri' }
const auth = (authToken: string, amountMinor: number, userId = 'u_ana') => ({ authToken, userId, cardToken: 'card_tok', amountMinor, merchant: 'Sette Archi' })

describe('card sub-ledger', () => {
  it('links a card to a user and finds it by user, token and last four', () => {
    const { store } = fresh()
    store.linkCard('u_ana', card)
    expect(store.cardOf('u_ana')).toMatchObject({ userId: 'u_ana', id: 'card_01', token: 'card_tok', last4: '4417', state: 'OPEN', holderName: 'Ana Ferri' })
    expect(store.cardByToken('card_tok')?.userId).toBe('u_ana')
    expect(store.cardsByLast4('4417').map((c) => c.userId)).toEqual(['u_ana'])
    store.setCardState('u_ana', 'PAUSED')
    expect(store.cardOf('u_ana')?.state).toBe('PAUSED')
  })

  it('credits a deposit once per intent id', () => {
    const { store } = fresh()
    expect(store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 500 })).toEqual({ credited: true, balanceMinor: 500 })
    expect(store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 500 })).toEqual({ credited: false, balanceMinor: 500 })
    expect(store.balance('u_ana')).toBe(500)
  })

  it('approves when the balance covers the amount and spends it at once', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    expect(store.authorize(auth('a1', 600))).toMatchObject({ approved: true, duplicate: false })
    expect(store.balance('u_ana')).toBe(400)
    expect(store.hold('a1')).toMatchObject({ status: 'authorised', amountMinor: 600, merchant: 'Sette Archi' })
  })

  it('declines when the amount exceeds the balance (spent funds are not spendable twice)', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    store.authorize(auth('a1', 600))
    expect(store.authorize(auth('a2', 500)).approved).toBe(false)
    expect(store.balance('u_ana')).toBe(400)
    expect(store.hold('a2')).toMatchObject({ status: 'declined', declineReason: DECLINE_COPY.insufficient })
  })

  it('declines a frozen card without spending', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    expect(store.authorize({ ...auth('a1', 100), frozen: true }).approved).toBe(false)
    expect(store.hold('a1')?.declineReason).toBe(DECLINE_COPY.frozen)
    expect(store.balance('u_ana')).toBe(1000)
  })

  it('a declined amount is approved after a new deposit', () => {
    const { store } = fresh()
    expect(store.authorize(auth('a1', 2500)).approved).toBe(false)
    store.creditDeposit({ intentId: 'int_2', userId: 'u_ana', amountMinor: 3000 })
    expect(store.authorize(auth('a2', 2500)).approved).toBe(true)
    expect(store.balance('u_ana')).toBe(500)
  })

  it('is idempotent per authorization token: a retry gets the same answer and spends nothing more', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    store.authorize(auth('a1', 600))
    expect(store.authorize(auth('a1', 600))).toMatchObject({ approved: true, duplicate: true })
    expect(store.balance('u_ana')).toBe(400)
    store.authorize(auth('a2', 900))
    expect(store.authorize(auth('a2', 1))).toMatchObject({ approved: false, duplicate: true })
  })

  it('a void gives the amount back once', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    store.authorize(auth('a1', 600))
    expect(store.voidHold('a1')).toBe(true)
    expect(store.voidHold('a1')).toBe(false)
    expect(store.balance('u_ana')).toBe(1000)
    expect(store.hold('a1')?.status).toBe('voided')
    // A cleared purchase can no longer be voided.
    store.authorize(auth('a2', 300))
    expect(store.complete('a2')).toBe(true)
    expect(store.voidHold('a2')).toBe(false)
    expect(store.balance('u_ana')).toBe(700)
  })

  it('clearing completes once; clearing for less gives the difference back', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    store.authorize(auth('a1', 600))
    expect(store.complete('a1', 450)).toBe(true)
    expect(store.complete('a1', 450)).toBe(false)
    expect(store.balance('u_ana')).toBe(550)
    expect(store.hold('a1')).toMatchObject({ status: 'completed', amountMinor: 450 })
  })

  it('clearing for more than authorised (a tip) takes the extra only when the card covers it', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1500 })
    store.authorize(auth('a1', 1000))
    expect(store.complete('a1', 1150)).toBe(true)
    expect(store.balance('u_ana')).toBe(350)
    expect(store.hold('a1')).toMatchObject({ status: 'completed', amountMinor: 1150 })
    // 350 left: a clearing 400 above its authorization is not covered, the purchase keeps its authorised amount.
    store.authorize(auth('a2', 100))
    expect(store.complete('a2', 500)).toBe(true)
    expect(store.balance('u_ana')).toBe(250)
    expect(store.hold('a2')).toMatchObject({ status: 'completed', amountMinor: 100 })
  })

  it('a refund (return) credits once per key and shows as its own line', () => {
    const { store } = fresh()
    expect(store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })).toBe(true)
    expect(store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })).toBe(false)
    expect(store.balance('u_ana')).toBe(250)
    expect(store.hold('ret_1')?.status).toBe('refunded')
  })

  it('a refund stores its way back to the pool on the ledger with it, once per key', () => {
    const { store } = fresh()
    store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })
    store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })
    expect(store.openReturns()).toEqual([expect.objectContaining({ key: 'ret_1', amountMinor: 250, status: 'pending', tries: 0 })])
  })

  it('a way back to the pool: reserved before the submit, released on a refusal, sent once, stopped by hand', () => {
    const { store } = fresh()
    store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })
    expect(store.returnTry('ret_1')).toBe(1)
    store.reserveReturn('ret_1', { sequence: 7, lastLedger: 1020, fromLedger: 1000, fingerprint: 'ConfidentialMPTSend:AA' })
    expect(store.returnOf('ret_1')).toMatchObject({ status: 'reserved', sequence: 7, lastLedger: 1020, fromLedger: 1000, fingerprint: 'ConfidentialMPTSend:AA', tries: 1 })
    store.returnFailed('ret_1', 'tecNO_PERMISSION', { release: true })
    expect(store.returnOf('ret_1')).toMatchObject({ status: 'pending', error: 'tecNO_PERMISSION' })
    expect(store.returnOf('ret_1')?.sequence).toBeUndefined()
    expect(store.returnOf('ret_1')?.fromLedger).toBeUndefined()
    expect(store.hold('ret_1')?.settleError).toBe('tecNO_PERMISSION')
    store.reserveReturn('ret_1', { sequence: 8, lastLedger: 1030, fromLedger: 1010, fingerprint: 'ConfidentialMPTSend:BB' })
    store.returnSent('ret_1', 'CD'.repeat(32))
    expect(store.returnOf('ret_1')).toMatchObject({ status: 'sent', txHash: 'CD'.repeat(32) })
    expect(store.returnOf('ret_1')?.error).toBeUndefined()
    expect(store.hold('ret_1')?.settleError).toBeUndefined()
    expect(store.openReturns()).toEqual([])

    store.refund({ key: 'ret_2', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 100, merchant: 'Sette Archi' })
    store.returnFailed('ret_2', 'sequence 9 is older than the last 200 transactions', { stop: true })
    expect(store.returnOf('ret_2')).toMatchObject({ status: 'stopped' })
    expect(store.openReturns()).toEqual([])
  })

  it('a refund recorded before the way back existed gets one on the next start', () => {
    const { db, ctx, store } = fresh()
    store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })
    db.exec('DELETE FROM card_returns')
    expect(cardStore(ctx).openReturns().map((r) => [r.key, r.amountMinor])).toEqual([['ret_1', 250]])
  })

  it('a card_returns table from before the reserve kept its ledger gets the column on start', () => {
    const db = openDb(':memory:')
    db.exec(`CREATE TABLE card_returns (key TEXT PRIMARY KEY, amount_minor INTEGER NOT NULL, status TEXT NOT NULL, sequence INTEGER, last_ledger INTEGER,
      fingerprint TEXT, tx_hash TEXT, error TEXT, tries INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    const store = cardStore({ db, iso: () => '2026-11-21T09:00:00.000Z' })
    store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })
    store.reserveReturn('ret_1', { sequence: 7, lastLedger: 1020, fromLedger: 1000, fingerprint: 'ConfidentialMPTSend:AA' })
    expect(store.returnOf('ret_1')).toMatchObject({ status: 'reserved', fromLedger: 1000 })
  })

  it('lists recent authorizations newest first, in the contract shape', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    store.authorize(auth('a1', 600))
    store.authorize(auth('a2', 900))
    const list = store.holdsOf('u_ana', 10).map(toAuthorization)
    expect(list.map((a) => [a.id, a.approved, a.status])).toEqual([
      ['a2', false, 'declined'],
      ['a1', true, 'authorised'],
    ])
    expect(list[0].declineReason).toBe(DECLINE_COPY.insufficient)
    expect(store.openHolds().map((h) => h.authToken)).toEqual(['a1'])
  })

  it('annotates a hold with its settlement', () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    store.authorize(auth('a1', 600))
    store.annotate('a1', { settleTx: 'AB'.repeat(32), orderId: 'ord_1' })
    store.annotate('a1', { settleError: 'payout refused' })
    expect(store.hold('a1')).toMatchObject({ settleTx: 'AB'.repeat(32), settleError: 'payout refused', orderId: 'ord_1' })
  })

  it('survives a new store on the same database', () => {
    const { store, ctx } = fresh()
    store.linkCard('u_ana', card)
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 700 })
    const again = cardStore(ctx)
    expect(again.cardByToken('card_tok')?.userId).toBe('u_ana')
    expect(again.balance('u_ana')).toBe(700)
  })

  it("a shop charge counts while its purchase stands; once voided, the order's next charge replaces it", () => {
    const { store } = fresh()
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 3000 })
    const receipt = (reference: string) => ({ orderNumber: 'SA-1', shopName: 'Sette Archi', items: [], amountMinor: 1450, method: 'card' as const, status: 'authorised' as const, at: '2026-11-21T09:00:00.000Z', reference })
    store.authorize({ ...auth('a1', 1450), orderId: 'ord_1' })
    expect(store.saveCharge('ord_1', 'a1', receipt('a1'))).toBe(true)
    store.authorize({ ...auth('a2', 1450), orderId: 'ord_1' })
    expect(store.saveCharge('ord_1', 'a2', receipt('a2'))).toBe(false) // a1 still stands
    expect(store.charge('ord_1')?.authToken).toBe('a1')
    store.voidHold('a1')
    expect(store.charge('ord_1')).toBeUndefined()
    expect(store.saveCharge('ord_1', 'a2', receipt('a2'))).toBe(true)
    expect(store.charge('ord_1')?.authToken).toBe('a2')
  })

  it('counts clearing tries, also on a database made before the column existed', () => {
    const db = openDb(':memory:')
    db.exec(`CREATE TABLE card_holds (auth_token TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, user_id TEXT NOT NULL, card_token TEXT NOT NULL,
      amount_minor INTEGER NOT NULL, merchant TEXT NOT NULL, status TEXT NOT NULL, decline_reason TEXT, order_id TEXT, settle_tx TEXT, settle_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`)
    const store = cardStore({ db, iso: () => new Date().toISOString() })
    store.creditDeposit({ intentId: 'int_1', userId: 'u_ana', amountMinor: 1000 })
    store.authorize(auth('a1', 600))
    expect(store.hold('a1')?.clearTries).toBeUndefined()
    expect(store.clearTry('a1')).toBe(1)
    expect(store.clearTry('a1')).toBe(2)
    expect(store.hold('a1')?.clearTries).toBe(2)
  })

  it('rejects non-integer or negative amounts', () => {
    const { store } = fresh()
    expect(() => store.creditDeposit({ intentId: 'i', userId: 'u_ana', amountMinor: 1.5 })).toThrow()
    expect(() => store.authorize(auth('a1', -1))).toThrow()
  })
})
