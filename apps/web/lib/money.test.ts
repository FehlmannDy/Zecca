import { describe, expect, it } from 'vitest'
import { amountParts } from './money'

describe('amount display', () => {
  it('splits dollars and cents with separators, tabular-ready', () => {
    expect(amountParts(123456)).toEqual({ sign: '', dollars: '1,234', cents: '56', text: '$1,234.56', spoken: '1234 dollars 56' })
    expect(amountParts(5)).toMatchObject({ dollars: '0', cents: '05', text: '$0.05' })
  })
  it('marks received money with + and sent money with nothing, never colour alone', () => {
    expect(amountParts(1200, { direction: 'in' })).toMatchObject({ sign: '+', text: '+$12.00' })
    expect(amountParts(1200, { direction: 'out' })).toMatchObject({ sign: '', text: '$12.00' })
  })
  it('refuses floats', () => {
    expect(() => amountParts(12.5)).toThrow()
  })
})
