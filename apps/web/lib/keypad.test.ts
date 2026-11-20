import { describe, expect, it } from 'vitest'
import { keypadPress, sanitizeAmountInput } from './keypad'

const type = (keys: string) => [...keys].reduce((s, k) => keypadPress(s, k === '<' ? 'back' : k), '')

describe('amount keypad', () => {
  it('builds an amount key by key, two decimals at most', () => {
    expect(type('12')).toBe('12')
    expect(type('12.5')).toBe('12.5')
    expect(type('12.505')).toBe('12.50')
    expect(type('.5')).toBe('0.5')
    expect(type('1..2')).toBe('1.2')
  })
  it('drops leading zeros and handles backspace', () => {
    expect(type('007')).toBe('7')
    expect(type('0.07')).toBe('0.07')
    expect(type('12<')).toBe('1')
    expect(type('1<<')).toBe('')
  })
  it('caps the length so the amount fits the screen', () => {
    expect(type('1234567890')).toBe('1234567')
  })
  it('cleans what is typed or pasted into the field', () => {
    expect(sanitizeAmountInput('$1,200.555')).toBe('1200.55')
    expect(sanitizeAmountInput('abc')).toBe('')
    expect(sanitizeAmountInput('12,5')).toBe('12.5')
  })
})
