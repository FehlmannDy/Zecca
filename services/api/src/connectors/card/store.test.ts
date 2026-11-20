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
const card = { token: 'card_tok', last4: '4417', expMonth: 11, expYear: 2029, state: 'OPEN' as const, holderName: 'Ana Ferri' }
const auth = (authToken: string, amountMinor: number, userId = 'u_ana') => ({ authToken, userId, cardToken: 'card_tok', amountMinor, merchant: 'Sette Archi' })

describe('card sub-ledger', () => {
  it('links a card to a user and finds it by user, token and last four', () => {
    const { store } = fresh()
    store.linkCard('u_ana', card)
    expect(store.cardOf('u_ana')).toMatchObject({ userId: 'u_ana', token: 'card_tok', last4: '4417', state: 'OPEN', holderName: 'Ana Ferri' })
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

  it('a refund (return) credits once per key and shows as its own line', () => {
    const { store } = fresh()
    expect(store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })).toBe(true)
    expect(store.refund({ key: 'ret_1', userId: 'u_ana', cardToken: 'card_tok', amountMinor: 250, merchant: 'Sette Archi' })).toBe(false)
    expect(store.balance('u_ana')).toBe(250)
    expect(store.hold('ret_1')?.status).toBe('refunded')
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

  it('rejects non-integer or negative amounts', () => {
    const { store } = fresh()
    expect(() => store.creditDeposit({ intentId: 'i', userId: 'u_ana', amountMinor: 1.5 })).toThrow()
    expect(() => store.authorize(auth('a1', -1))).toThrow()
  })
})
