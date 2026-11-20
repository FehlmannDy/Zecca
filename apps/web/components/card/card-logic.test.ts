import { describe, expect, it } from 'vitest'
import type { CardAuthorization } from '@zecca/contracts'
import { authLine, authStatusLabel, cardFormErrors, formatCardNumberInput, formatExpiry, formatPan, parseExpiry, tiltFrom, upsertAuthorization } from './card-logic'

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
    expect(formatCardNumberInput('4111-1111 11114417999999')).toBe('4111 1111 1111 4417 999')
    expect(formatCardNumberInput('41a1')).toBe('411')
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
