import { describe, expect, it } from 'vitest'
import { fitChartWidth } from './chart-width'

describe('Peak Chart width on a phone', () => {
  it('fills the column inside the 16 px gutters, up to 380 px, never under 280 px', () => {
    expect(fitChartWidth(360)).toBe(328)
    expect(fitChartWidth(390)).toBe(358)
    expect(fitChartWidth(430)).toBe(380)
    expect(fitChartWidth(1280)).toBe(380)
    expect(fitChartWidth(300)).toBe(280)
  })
})
