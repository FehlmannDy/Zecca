import { describe, expect, it } from 'vitest'
import { marketAssets } from '@zecca/contracts/fixtures'
import { changeText, chartLabels, estimate, gramsText, needsAuthorizeFirst, parseGrams, perGram, priceTime, sparkPath, symbolOf, tradeTitle } from './market-model'

describe('market screen model', () => {
  it('prices per gram and grams, from integers', () => {
    expect(perGram(11378)).toBe('$113.78 / g')
    expect(gramsText(87)).toBe('0.087 g')
    expect(gramsText(1500)).toBe('1.5 g')
    expect(gramsText(0)).toBe('0 g')
  })

  it('parses grams typed by a person into milligrams, without floats', () => {
    expect(parseGrams('1.5')).toBe(1500)
    expect(parseGrams('0.087')).toBe(87)
    expect(parseGrams(' 2 ')).toBe(2000)
    expect(parseGrams('0,5')).toBe(500)
    expect(parseGrams('1.2345')).toBeNull()
    expect(parseGrams('abc')).toBeNull()
    expect(parseGrams('0')).toBeNull()
  })

  it('estimates before asking the server (the server quote is what gets approved)', () => {
    const gold = marketAssets[0] // buy 8454, sell 8370
    expect(estimate(gold, 'buy', { amountMinor: 1000 })).toEqual({ quantityMg: 118, amountMinor: 998 })
    expect(estimate(gold, 'sell', { quantityMg: 1500 })).toEqual({ quantityMg: 1500, amountMinor: 12555 })
    expect(estimate(gold, 'buy', { amountMinor: 1 })).toBeNull()
  })

  it('says the change in words and signs, not colour alone', () => {
    expect(changeText(0.5)).toEqual({ text: '+0.5%', spoken: 'up 0.5 percent', dir: 'up' })
    expect(changeText(-5)).toEqual({ text: '−5.0%', spoken: 'down 5.0 percent', dir: 'down' })
    expect(changeText(0)).toEqual({ text: '0.0%', spoken: 'unchanged', dir: 'flat' })
    expect(changeText(undefined)).toBeNull()
  })

  it('draws a sparkline only with two points or more', () => {
    expect(sparkPath([1], 100, 20)).toBeNull()
    expect(sparkPath([10, 20, 10], 100, 20)).toBe('M0,19 L50,1 L100,19')
    expect(sparkPath([5, 5], 100, 20)).toBe('M0,10 L100,10')
  })

  it('knows a first purchase needs the holding opened first', () => {
    expect(needsAuthorizeFirst({ prepared: { kind: 'market_authorize' } })).toBe(true)
    expect(needsAuthorizeFirst({ prepared: { kind: 'send' } })).toBe(false)
  })

  it('titles the approval', () => {
    expect(tradeTitle('buy', 'Gold', { quantityMg: 87, amountMinor: 995 })).toBe('Buy 0.087 g of gold for $9.95')
    expect(tradeTitle('sell', 'Silver', { quantityMg: 50_000, amountMinor: 5050 })).toBe('Sell 50 g of silver for $50.50')
  })

  it('reads the route symbol and dates the price', () => {
    expect(symbolOf('xau')).toBe('XAU')
    expect(symbolOf('XPD')).toBe('XPD')
    expect(symbolOf('BTC')).toBeNull()
    expect(priceTime('2026-11-20T21:59:57.000Z', 'UTC')).toBe('Nov 20, 9:59 PM')
    expect(priceTime('2026-11-20T09:05:00.000Z', 'UTC')).toBe('Nov 20, 9:05 AM')
    expect(chartLabels(3)).toEqual(['2 closes ago', 'Previous close', 'Latest'])
  })
})
