import { describe, expect, it } from 'vitest'
import { QuoteError, halfSpreadMinor, perGramFromOunce, quoteBuy, quoteSell, sidePrices, valueOfMg } from './quote'

describe('market quote maths (integers: cents and milligrams)', () => {
  it('half the spread is rounded half up, per gram', () => {
    // 100 bps spread: 0.5% each side
    expect(halfSpreadMinor(8412, 100)).toBe(42) // 42.06
    expect(halfSpreadMinor(102, 100)).toBe(1) // 0.51
    expect(halfSpreadMinor(3320, 100)).toBe(17) // 16.6
    expect(halfSpreadMinor(100, 100)).toBe(1) // 0.5 -> 1
    expect(halfSpreadMinor(99, 100)).toBe(0) // 0.495
    expect(halfSpreadMinor(8412, 0)).toBe(0)
    expect(halfSpreadMinor(10_000, 101)).toBe(51) // 50.5 -> 51 (odd bps)
  })

  it('buy and sell prices sit around the feed price (contract fixtures)', () => {
    expect(sidePrices(8412, 100)).toEqual({ buyPriceMinor: 8454, sellPriceMinor: 8370 })
    expect(sidePrices(102, 100)).toEqual({ buyPriceMinor: 103, sellPriceMinor: 101 })
    expect(sidePrices(3320, 100)).toEqual({ buyPriceMinor: 3337, sellPriceMinor: 3303 })
    // never a sell price of zero
    expect(sidePrices(1, 10_000).sellPriceMinor).toBe(1)
  })

  it('values milligrams at a per-gram price, rounded down', () => {
    expect(valueOfMg(1500, 8412)).toBe(12618)
    expect(valueOfMg(1, 8412)).toBe(8)
    expect(valueOfMg(0, 8412)).toBe(0)
  })

  it('buy by amount: whole milligrams the amount affords, charged what they cost (never more than asked)', () => {
    const q = quoteBuy({ priceMinor: 8412, spreadBps: 100, amountMinor: 1000 })
    // 1000 * 1000 / 8454 = 118.28 -> 118 mg; 118 * 8454 / 1000 = 997.572 -> 998
    expect(q).toEqual({ quantityMg: 118, amountMinor: 998, unitPriceMinor: 8454, spreadMinor: 6, feedValueMinor: 992 })
    expect(q.amountMinor).toBeLessThanOrEqual(1000)
  })

  it('buy by quantity: charged the buy price, rounded up to the cent', () => {
    expect(quoteBuy({ priceMinor: 8412, spreadBps: 100, quantityMg: 1000 })).toEqual({
      quantityMg: 1000,
      amountMinor: 8454,
      unitPriceMinor: 8454,
      spreadMinor: 42,
      feedValueMinor: 8412,
    })
    expect(quoteBuy({ priceMinor: 8412, spreadBps: 100, quantityMg: 1 }).amountMinor).toBe(9) // 8.454 -> 9
  })

  it('sell by quantity: paid the sell price, rounded down to the cent', () => {
    expect(quoteSell({ priceMinor: 8412, spreadBps: 100, quantityMg: 1500 })).toEqual({
      quantityMg: 1500,
      amountMinor: 12555, // 1500 * 8370 / 1000
      unitPriceMinor: 8370,
      spreadMinor: 63, // 12618 - 12555
      feedValueMinor: 12618,
    })
  })

  it('sell by amount: the milligrams needed to receive at least that amount', () => {
    const q = quoteSell({ priceMinor: 8412, spreadBps: 100, amountMinor: 1000 })
    // 1000 * 1000 / 8370 = 119.47 -> 120 mg; 120 * 8370 / 1000 = 1004.4 -> 1004
    expect(q.quantityMg).toBe(120)
    expect(q.amountMinor).toBe(1004)
    expect(q.amountMinor).toBeGreaterThanOrEqual(1000)
    expect(q.spreadMinor).toBe(q.feedValueMinor - q.amountMinor)
  })

  it('the spread is never negative and buy always costs more than sell for the same quantity', () => {
    for (const price of [1, 7, 99, 102, 3320, 8412, 11_378]) {
      for (const mg of [1, 3, 118, 1000, 123_457]) {
        const b = quoteBuy({ priceMinor: price, spreadBps: 100, quantityMg: mg })
        expect(b.spreadMinor).toBeGreaterThanOrEqual(0)
        const s = (() => {
          try {
            return quoteSell({ priceMinor: price, spreadBps: 100, quantityMg: mg })
          } catch {
            return null
          }
        })()
        if (s) {
          expect(s.spreadMinor).toBeGreaterThanOrEqual(0)
          expect(b.amountMinor).toBeGreaterThanOrEqual(s.amountMinor)
        }
      }
    }
  })

  it('refuses amounts too small to buy or sell anything', () => {
    expect(() => quoteBuy({ priceMinor: 8412, spreadBps: 100, amountMinor: 8 })).toThrow(QuoteError)
    expect(() => quoteSell({ priceMinor: 8412, spreadBps: 100, quantityMg: 0 })).toThrow(QuoteError)
    expect(() => quoteSell({ priceMinor: 100, spreadBps: 100, quantityMg: 9 })).toThrow(QuoteError) // 9 * 99 / 1000 = 0.891 -> 0
  })

  it('refuses floats and needs exactly one of amount or quantity', () => {
    expect(() => quoteBuy({ priceMinor: 84.12, spreadBps: 100, amountMinor: 1000 })).toThrow(TypeError)
    expect(() => quoteBuy({ priceMinor: 8412, spreadBps: 100, amountMinor: 10.5 })).toThrow(TypeError)
    expect(() => quoteBuy({ priceMinor: 8412, spreadBps: 100 })).toThrow(TypeError)
    expect(() => quoteBuy({ priceMinor: 8412, spreadBps: 100, amountMinor: 1, quantityMg: 1 })).toThrow(TypeError)
  })

  it('converts a dollars-per-troy-ounce quote to cents per gram without float drift', () => {
    expect(perGramFromOunce('3539')).toBe(11378) // 3539 / 31.1034768 = 113.782
    expect(perGramFromOunce('41.080002')).toBe(132)
    expect(perGramFromOunce('893.0')).toBe(2871)
    expect(perGramFromOunce('3864.199951171875')).toBe(12424)
    expect(() => perGramFromOunce('abc')).toThrow()
    expect(() => perGramFromOunce('-1')).toThrow()
  })
})
