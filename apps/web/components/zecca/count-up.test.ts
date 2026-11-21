import { describe, expect, it } from 'vitest'
import { COUNT_CHANGE_MS, COUNT_FIRST_MS, countAt, countDuration, easeOutCubic } from './count-up'

describe('ease-out', () => {
  it('starts at 0, ends at 1, and is clamped outside', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(-1)).toBe(0)
    expect(easeOutCubic(2)).toBe(1)
  })
  it('is fast first and slow at the end (ease-out), always rising', () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
    const steps = Array.from({ length: 11 }, (_, i) => easeOutCubic(i / 10))
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1])
  })
})

describe('count-up value', () => {
  it('goes from the old value to the new one in whole cents', () => {
    expect(countAt(0, 5000, 0, 700)).toBe(0)
    expect(countAt(0, 5000, 700, 700)).toBe(5000)
    const mid = countAt(0, 5000, 350, 700)
    expect(Number.isInteger(mid)).toBe(true)
    expect(mid).toBeGreaterThan(2500)
    expect(mid).toBeLessThan(5000)
  })
  it('counts down too, never past either end', () => {
    const v = countAt(9000, 7800, 250, 500)
    expect(v).toBeLessThan(9000)
    expect(v).toBeGreaterThan(7800)
    expect(countAt(9000, 7800, 10_000, 500)).toBe(7800)
  })
  it('lands on the target at once with no duration', () => {
    expect(countAt(0, 4321, 0, 0)).toBe(4321)
  })
})

describe('count-up duration', () => {
  it('counts the first value up from zero, later changes a little faster', () => {
    expect(countDuration(0, 5000, true)).toBe(COUNT_FIRST_MS)
    expect(countDuration(5000, 9000, false)).toBe(COUNT_CHANGE_MS)
    expect(COUNT_CHANGE_MS).toBeLessThan(COUNT_FIRST_MS)
  })
  it('does not animate when nothing changes, or under reduced motion', () => {
    expect(countDuration(5000, 5000, false)).toBe(0)
    expect(countDuration(0, 5000, true, true)).toBe(0)
  })
})
