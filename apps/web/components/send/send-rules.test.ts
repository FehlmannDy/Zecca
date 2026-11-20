import { describe, expect, it } from 'vitest'
import { DEFAULTS, type Limits } from '@zecca/contracts'
import { checkSendAmount, firstName, followText, matchContacts, sendProblemOf, sentTitle } from './send-rules'

const limits: Limits = {
  txCapMinor: DEFAULTS.TX_CAP_MINOR,
  dailyCapMinor: DEFAULTS.DAILY_CAP_MINOR,
  tier0: { balanceCapMinor: 15_000, txCapMinor: 5_000, monthlySendCapMinor: 15_000 },
}

describe('checkSendAmount', () => {
  it('asks for an amount when there is none', () => {
    expect(checkSendAmount({ minor: null, availableMinor: 5000, tier: 0, limits })).toEqual({ kind: 'empty' })
    expect(checkSendAmount({ minor: 0, availableMinor: 5000, tier: 0, limits })).toEqual({ kind: 'empty' })
  })

  it('accepts an amount within the balance and the limits', () => {
    expect(checkSendAmount({ minor: 1200, availableMinor: 5000, tier: 0, limits })).toBeNull()
    expect(checkSendAmount({ minor: 5000, availableMinor: 5000, tier: 0, limits })).toBeNull()
  })

  it('opens the limit sheet above the tier 0 per-payment cap, before the balance check', () => {
    expect(checkSendAmount({ minor: 6000, availableMinor: 1000, tier: 0, limits })).toEqual({
      kind: 'limit',
      details: { limit: 'per_payment', capMinor: 5000, usedMinor: 6000 },
    })
  })

  it('states the verified cap in words (it is not a tier 0 limit)', () => {
    expect(checkSendAmount({ minor: 500_001, availableMinor: 900_000, tier: 1, limits })).toEqual({
      kind: 'message',
      message: 'Payments are limited to $5,000.00 each.',
    })
    expect(checkSendAmount({ minor: 6000, availableMinor: 9000, tier: 1, limits })).toBeNull()
  })

  it('says how much is missing', () => {
    expect(checkSendAmount({ minor: 1200, availableMinor: 1000, tier: 0, limits })).toEqual({ kind: 'short', shortMinor: 200, message: 'You need $2.00 more.' })
  })

  it('skips the balance check while the balance is not known', () => {
    expect(checkSendAmount({ minor: 1200, availableMinor: null, tier: 0, limits })).toBeNull()
  })
})

describe('sendProblemOf (API errors)', () => {
  it('opens the limit sheet for the sender’s tier 0 limits', () => {
    const details = { limit: 'monthly_send' as const, capMinor: 15_000, usedMinor: 14_000 }
    expect(sendProblemOf({ code: 'limit_reached', message: 'x', details })).toEqual({ kind: 'limit', details })
    expect(sendProblemOf({ code: 'limit_reached', message: 'x', details: { limit: 'per_payment' } })).toEqual({ kind: 'limit', details: { limit: 'per_payment' } })
  })

  it('shows the message as is when the limit is the recipient’s or a daily one', () => {
    const m = "Carla Rossi can't receive that much yet. Unverified accounts can hold up to $150.00."
    expect(sendProblemOf({ code: 'limit_reached', message: m, details: { limit: 'balance' } })).toEqual({ kind: 'message', message: m })
    expect(sendProblemOf({ code: 'limit_reached', message: 'Today', details: { limit: 'daily_cap' } })).toEqual({ kind: 'message', message: 'Today' })
  })

  it('turns insufficient funds into "You need $x more." with the amount', () => {
    expect(sendProblemOf({ code: 'insufficient_funds', message: 'You need $1.20 more.', details: { shortMinor: 120 } })).toEqual({
      kind: 'short',
      shortMinor: 120,
      message: 'You need $1.20 more.',
    })
  })

  it('keeps any other message as is', () => {
    expect(sendProblemOf({ code: 'bad_request', message: "You can't send money to yourself." })).toEqual({ kind: 'message', message: "You can't send money to yourself." })
  })
})

describe('copy', () => {
  it('uses the first name', () => {
    expect(firstName('Carla Rossi')).toBe('Carla')
    expect(firstName('  Caffè Bruno ')).toBe('Caffè')
    expect(firstName('')).toBe('')
  })
  it('writes the success line', () => {
    expect(sentTitle(1200, { displayName: 'Carla Rossi', isMerchant: false })).toBe('Sent. $12.00 to Carla.')
    expect(sentTitle(450, { displayName: 'Caffè Bruno', isMerchant: true })).toBe('Sent. $4.50 to Caffè Bruno.')
  })
})

describe('followText', () => {
  const carla = { displayName: 'Carla Rossi', isMerchant: false }
  it('follows the payment to the recipient', () => {
    expect(followText({ status: 'created' }, carla)).toEqual({ tone: 'muted', text: 'On its way to Carla.' })
    expect(followText({ status: 'submitted' }, carla)).toEqual({ tone: 'muted', text: 'On its way to Carla.' })
    expect(followText({ status: 'received' }, carla)).toEqual({ tone: 'muted', text: 'Carla has it.' })
    expect(followText({ status: 'paid_out' }, carla)).toEqual({ tone: 'muted', text: 'Carla has it.' })
  })
  it('says when it did not go through, expired included', () => {
    expect(followText({ status: 'failed', failure: { code: 'x', message: 'The payment didn’t go through.' } }, carla)).toEqual({ tone: 'alert', text: 'The payment didn’t go through.' })
    expect(followText({ status: 'expired' }, carla)).toEqual({ tone: 'alert', text: "This payment didn't go through. Nothing was taken." })
  })
})

describe('matchContacts', () => {
  const people = [
    { id: 'u1', handle: 'carla', displayName: 'Carla Rossi', isMerchant: false },
    { id: 'u2', handle: 'bruno', displayName: 'Caffè Bruno', isMerchant: true },
    { id: 'u3', handle: 'marco_r', displayName: 'Marco Ricci', isMerchant: false },
  ]
  it('lists everyone while nothing is typed', () => {
    expect(matchContacts(people, '  ')).toEqual(people)
  })
  it('matches the start of the handle or of any word of the name, ignoring case and accents', () => {
    expect(matchContacts(people, '@car').map((p) => p.id)).toEqual(['u1'])
    expect(matchContacts(people, 'ca').map((p) => p.id)).toEqual(['u1', 'u2'])
    expect(matchContacts(people, 'caffe').map((p) => p.id)).toEqual(['u2'])
    expect(matchContacts(people, 'ricci').map((p) => p.id)).toEqual(['u3'])
    expect(matchContacts(people, 'ossi')).toEqual([])
  })
  it('leaves out someone already shown', () => {
    expect(matchContacts(people, 'ca', 'u1').map((p) => p.id)).toEqual(['u2'])
  })
})
