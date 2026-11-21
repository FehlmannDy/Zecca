import { describe, expect, it } from 'vitest'
import { sparkGeometry, sparkLabel } from './home-spark'

const nums = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)

describe('balance sparkline geometry', () => {
  it('is hidden with fewer than two points', () => {
    expect(sparkGeometry([])).toBeNull()
    expect(sparkGeometry([5000])).toBeNull()
  })

  it('spans the full width, oldest on the left, and keeps zero at the bottom', () => {
    const g = sparkGeometry([0, 5000, 9000], { width: 100, height: 64, inset: 4 })!
    const xy = nums(g.line)
    expect(xy).toEqual([0, 60, 50, expect.any(Number), 100, 4])
    expect(xy[3]).toBeCloseTo(60 - (5000 / 9000) * 56, 1)
  })

  it('closes the area along the bottom edge', () => {
    const g = sparkGeometry([1000, 2000], { width: 100, height: 64, inset: 4 })!
    expect(g.area.startsWith(g.line)).toBe(true)
    expect(g.area).toMatch(/L100 64L0 64Z$/)
  })

  it('places the end dot at the last point, in percent of the box', () => {
    const g = sparkGeometry([0, 9000], { width: 100, height: 64, inset: 4 })!
    expect(g.end).toEqual({ xPct: 100, yPct: (4 / 64) * 100 })
  })

  it('draws an all-zero history along the bottom (no division by zero)', () => {
    const g = sparkGeometry([0, 0, 0], { width: 100, height: 64, inset: 4 })!
    expect(nums(g.line).filter((_, i) => i % 2 === 1)).toEqual([60, 60, 60])
  })
})

describe('balance sparkline label', () => {
  it('reads the change in words', () => {
    expect(sparkLabel([0, 5000, 7800], 'daily')).toBe('Balance by day, from $0.00 to $78.00')
    expect(sparkLabel([0, 5000], 'running')).toBe('Balance today, from $0.00 to $50.00')
  })
  it('says when the end of the line includes money still arriving', () => {
    expect(sparkLabel([0, 9000], 'running', 4000)).toBe('Balance today, from $0.00 to $90.00, including $40.00 arriving')
    expect(sparkLabel([0, 5000], 'running', 0)).toBe('Balance today, from $0.00 to $50.00')
  })
})
