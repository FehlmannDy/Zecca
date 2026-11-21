import { describe, expect, it } from 'vitest'
import { formatExpiry, parseExpiry } from './expiry'

describe('formatExpiry', () => {
  it('adds the slash a numeric keypad cannot type', () => {
    expect(formatExpiry('1')).toBe('1')
    expect(formatExpiry('12')).toBe('12')
    expect(formatExpiry('122')).toBe('12/2')
    expect(formatExpiry('1228')).toBe('12/28')
    expect(formatExpiry('122899')).toBe('12/28')
  })
  it('keeps a typed or autofilled slash', () => {
    expect(formatExpiry('12/')).toBe('12/')
    expect(formatExpiry('1/')).toBe('01/')
    expect(formatExpiry('12/28')).toBe('12/28')
    expect(formatExpiry('12/2028')).toBe('12/2028')
    expect(formatExpiry(' 12 / 28 ')).toBe('12/28')
  })
  it('lets backspace remove the slash', () => {
    expect(formatExpiry('12/')).toBe('12/')
    expect(formatExpiry('12')).toBe('12')
    expect(formatExpiry('/')).toBe('')
  })
})

describe('parseExpiry', () => {
  it('reads MM/YY and MM/YYYY', () => {
    expect(parseExpiry('12/28')).toEqual({ expMonth: 12, expYear: 2028 })
    expect(parseExpiry('01/2030')).toEqual({ expMonth: 1, expYear: 2030 })
  })
  it('refuses the rest', () => {
    expect(parseExpiry('1228')).toBeNull()
    expect(parseExpiry('13/28')).toBeNull()
    expect(parseExpiry('00/28')).toBeNull()
    expect(parseExpiry('12/2')).toBeNull()
  })
})
