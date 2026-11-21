import { describe, expect, it } from 'vitest'
import { addToBasket, basketLines, parseBasket, setQty, toOrderItems } from './basket'

const items = [
  { sku: 'guji-250', name: 'Ethiopia Guji, 250 g', priceMinor: 1450 },
  { sku: 'moka-3', name: 'Moka pot, 3 cups', priceMinor: 3200 },
]

describe('demo shop basket', () => {
  it('adds, changes and removes quantities (1 to 20)', () => {
    let b = addToBasket({}, 'guji-250')
    b = addToBasket(b, 'guji-250')
    expect(b).toEqual({ 'guji-250': 2 })
    expect(setQty(b, 'guji-250', 25)).toEqual({ 'guji-250': 20 })
    expect(setQty(b, 'guji-250', 0)).toEqual({})
  })

  it('lines and total in integer cents, unknown skus dropped', () => {
    const r = basketLines({ 'guji-250': 2, 'moka-3': 1, gone: 3 }, items)
    expect(r.lines.map((l) => [l.sku, l.qty, l.lineMinor])).toEqual([
      ['guji-250', 2, 2900],
      ['moka-3', 1, 3200],
    ])
    expect(r.totalMinor).toBe(6100)
    expect(r.count).toBe(3)
  })

  it('order items for POST /v1/demo/shop/orders', () => {
    expect(toOrderItems({ 'guji-250': 2, 'moka-3': 1 })).toEqual([
      { sku: 'guji-250', qty: 2 },
      { sku: 'moka-3', qty: 1 },
    ])
  })

  it('parses what was stored, ignoring junk', () => {
    expect(parseBasket('{"guji-250":2,"x":"a","y":-1,"z":1.5}')).toEqual({ 'guji-250': 2 })
    expect(parseBasket('not json')).toEqual({})
    expect(parseBasket(null)).toEqual({})
  })
})
