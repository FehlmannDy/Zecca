import { describe, expect, it } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import type { PublicConfig } from '@zecca/contracts'
import { limitView } from './limit-view'

const limits = (fx.config as PublicConfig).limits

describe('limit sheet view', () => {
  it('lists the tier 0 caps for an unverified account that hit its own cap', () => {
    expect(limitView({ tier: 0, limits, details: { limit: 'per_payment' } })).toEqual({ kind: 'tier0', hit: 'per_payment' })
    expect(limitView({ tier: 0, limits, details: { limit: 'balance' } })).toEqual({ kind: 'tier0', hit: 'balance' })
    expect(limitView({ tier: undefined, limits, details: { limit: 'monthly_send' } })).toEqual({ kind: 'tier0', hit: 'monthly_send' })
  })

  it('never shows a verified payer the unverified sheet: a capped recipient is said in the API words', () => {
    const msg = "Caffè Bruno can't receive that much yet. Unverified accounts can hold up to $150.00."
    expect(limitView({ tier: 1, limits, details: { limit: 'balance', capMinor: 15_000 }, message: msg })).toEqual({ kind: 'other', title: 'This payment is over a limit.', line: msg })
    expect(limitView({ tier: 1, limits, details: { limit: 'balance', capMinor: 15_000 } })).toEqual({
      kind: 'other',
      title: 'This payment is over a limit.',
      line: "The recipient can't receive that much yet. Unverified accounts can hold up to $150.00.",
    })
  })

  it('says the verified caps in words', () => {
    expect(limitView({ tier: 1, limits, details: { limit: 'tx_cap', capMinor: 500_000 } })).toMatchObject({ kind: 'other', line: 'Payments are limited to $5,000.00 each.' })
    expect(limitView({ tier: 1, limits, details: { limit: 'daily_cap' } })).toMatchObject({ kind: 'other', line: "You've reached today's limit of $10,000.00. Try again tomorrow." })
    expect(limitView({ tier: 0, limits, details: { limit: 'daily_cap' } })).toMatchObject({ kind: 'other' })
  })
})
