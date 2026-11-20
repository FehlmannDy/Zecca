import { describe, expect, it } from 'vitest'
import { nextSpaceMode } from './space-mode'

describe('nextSpaceMode (/merchant)', () => {
  it('waits for the stored session, then picks the space or the sign-up', () => {
    expect(nextSpaceMode('unknown', false, true)).toBe('unknown')
    expect(nextSpaceMode('unknown', true, true)).toBe('space')
    expect(nextSpaceMode('unknown', true, false)).toBe('signup')
  })

  it('keeps the sign-up on screen once it finishes ("You\'re set"), until the flow hands over', () => {
    expect(nextSpaceMode('signup', true, true)).toBe('signup')
    expect(nextSpaceMode('signup', true, false)).toBe('signup')
  })

  it('goes back to the sign-up when the session ends (sign-out or a 401) instead of a blank page', () => {
    expect(nextSpaceMode('space', true, false)).toBe('signup')
    expect(nextSpaceMode('space', true, true)).toBe('space')
  })
})
