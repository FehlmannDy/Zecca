import { describe, expect, it } from 'vitest'
import { requestLink, sendToParam } from './request-link'

describe('requestLink', () => {
  it('points at the send screen with the handle', () => {
    expect(requestLink('https://zecca.app', 'ana')).toBe('https://zecca.app/app/send?to=ana')
    expect(requestLink('http://localhost:3100/', 'ana_b')).toBe('http://localhost:3100/app/send?to=ana_b')
  })
})

describe('sendToParam', () => {
  it('reads ?to= and drops a leading @', () => {
    expect(sendToParam('?to=carla')).toBe('carla')
    expect(sendToParam('?to=%40carla')).toBe('carla')
    expect(sendToParam('?to=%2B39%20333%20123')).toBe('+39 333 123')
  })
  it('returns null when absent or empty', () => {
    expect(sendToParam('')).toBeNull()
    expect(sendToParam('?to=')).toBeNull()
    expect(sendToParam('?x=1')).toBeNull()
  })
})
