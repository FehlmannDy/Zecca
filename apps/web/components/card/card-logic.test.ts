import { describe, expect, it } from 'vitest'
import type { CardAuthorization } from '@zecca/contracts'
import {
  authLine,
  authStatusLabel,
  cardFormErrors,
  cardLengths,
  formatCardNumberInput,
  formatCvcInput,
  formatExpiry,
  formatExpiryInput,
  formatPan,
  latestOnly,
  parseExpiry,
  tiltFrom,
  upsertAuthorization,
} from './card-logic'

const a = (id: string, status: CardAuthorization['status'], o: Partial<CardAuthorization> = {}): CardAuthorization => ({
  id,
  amountMinor: 1450,
  merchant: 'Sette Archi',
  approved: status !== 'declined',
  status,
  at: '2026-11-21T09:00:00.000Z',
  ...o,
})

describe('card numbers and expiry', () => {
  it('groups a number by four', () => {
    expect(formatPan('4111111111114417')).toBe('4111 1111 1111 4417')
    expect(formatCardNumberInput('4111-1111 11114417999999')).toBe('4111 1111 1111 4417')
    expect(formatCardNumberInput('41a1')).toBe('411')
    expect(formatCardNumberInput('4111 ')).toBe('4111')
  })

  it('stops the number and the code at the card length (American Express: 15 and 4)', () => {
    expect(cardLengths('4111')).toEqual({ pan: 16, cvc: 3 })
    expect(cardLengths('3782')).toEqual({ pan: 15, cvc: 4 })
    expect(formatCardNumberInput('3782822463100059')).toBe('3782 8224 6310 005')
    expect(formatCvcInput('12345', '4111 1111 1111 1111')).toBe('123')
    expect(formatCvcInput('12a3', '')).toBe('123')
    expect(formatCvcInput('12345', '3782 8224 6310 005')).toBe('1234')
  })

  it('types the expiry on a keypad without a slash', () => {
    expect(formatExpiryInput('1')).toBe('1')
    expect(formatExpiryInput('12')).toBe('12')
    expect(formatExpiryInput('122')).toBe('12/2')
    expect(formatExpiryInput('1228')).toBe('12/28')
    expect(formatExpiryInput('122899')).toBe('12/28')
    expect(formatExpiryInput('5')).toBe('05')
    expect(formatExpiryInput('528')).toBe('05/28')
  })

  it('keeps a typed or autofilled slash, and lets backspace remove it', () => {
    expect(formatExpiryInput('1/')).toBe('01/')
    expect(formatExpiryInput('12/')).toBe('12/')
    expect(formatExpiryInput('12/289')).toBe('12/28')
    expect(formatExpiryInput('12/2028')).toBe('12/28')
    expect(formatExpiryInput(' 12 / 28 ')).toBe('12/28')
    expect(formatExpiryInput('/')).toBe('')
  })

  it('shows and reads MM/YY', () => {
    expect(formatExpiry(1, 2030)).toBe('01/30')
    expect(parseExpiry('11/29')).toEqual({ expMonth: 11, expYear: 2029 })
    expect(parseExpiry('1129')).toEqual({ expMonth: 11, expYear: 2029 })
    expect(parseExpiry('11 / 2029')).toEqual({ expMonth: 11, expYear: 2029 })
    expect(parseExpiry('13/29')).toBeNull()
    expect(parseExpiry('')).toBeNull()
  })

  it('says what is wrong with a card form, in English', () => {
    const now = new Date('2026-11-21T09:00:00Z')
    expect(cardFormErrors({ number: '4111 1111 1111 4417', expiry: '11/29', cvc: '123' }, now)).toEqual({})
    expect(cardFormErrors({ number: '', expiry: '', cvc: '' }, now)).toEqual({
      number: 'Enter the card number.',
      expiry: 'Enter the expiry as MM/YY.',
      cvc: 'Enter the 3 or 4 digit code.',
    })
    expect(cardFormErrors({ number: '4111', expiry: '10/26', cvc: '12' }, now)).toMatchObject({ number: 'This card number is too short.', expiry: 'This card has expired.' })
    expect(cardFormErrors({ number: '4111111111114417', expiry: '11/26', cvc: '123' }, now)).toEqual({})
  })
})

describe('card payments list', () => {
  it('puts a new payment first and replaces one it already has', () => {
    const list = [a('t1', 'authorised')]
    expect(upsertAuthorization(list, a('t2', 'declined')).map((x) => x.id)).toEqual(['t2', 't1'])
    const done = upsertAuthorization(list, a('t1', 'completed'))
    expect(done).toHaveLength(1)
    expect(done[0].status).toBe('completed')
  })

  it('says each status in words', () => {
    expect(authStatusLabel('authorised')).toBe('Authorised')
    expect(authStatusLabel('completed')).toBe('Completed')
    expect(authStatusLabel('declined')).toBe('Declined')
    expect(authStatusLabel('voided')).toBe('Cancelled')
    expect(authStatusLabel('refunded')).toBe('Refunded')
    expect(authLine(a('t', 'declined'))).toBe('Declined, not enough on the card')
    expect(authLine(a('t', 'declined', { declineReason: 'Declined, the card is frozen' }))).toBe('Declined, the card is frozen')
    expect(authLine(a('t', 'authorised'))).toBe('Authorised')
  })
})

describe('tilt', () => {
  it('turns a pointer position into a few degrees, at most 6', () => {
    expect(tiltFrom(0.5, 0.5)).toEqual({ rx: 0, ry: 0, lx: 50, ly: 50 })
    expect(tiltFrom(1, 0)).toEqual({ rx: 6, ry: 6, lx: 100, ly: 0 })
    expect(tiltFrom(-3, 7)).toEqual({ rx: -6, ry: -6, lx: 0, ly: 100 })
  })
})

describe('latestOnly (card details: an answer that arrives after Hide is dropped)', () => {
  it('keeps only the answer of the latest request, and none after a cancel', () => {
    const req = latestOnly()
    const first = req.begin()
    expect(first()).toBe(true)
    const second = req.begin()
    expect([first(), second()]).toEqual([false, true])
    req.cancel() // the user tapped Hide before the answer came back
    expect(second()).toBe(false)
  })
})
