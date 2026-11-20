// The demo shop's catalogue (the contracts' fixtures) and order pricing in integer cents.
import { shopItems } from '@zecca/contracts/fixtures'
import { Err } from '../errors'

export type ShopLine = { sku: string; name: string; qty: number; unitMinor: number }

export const SHOP_NAME = 'Sette Archi'

export const catalog = () => shopItems.map((i) => ({ ...i }))

/** Lines (repeated skus merged, first-seen order) and the total. Unknown skus are a 400. */
export function priceOrder(items: Array<{ sku: string; qty: number }>): { amountMinor: number; lines: ShopLine[] } {
  const lines = new Map<string, ShopLine>()
  for (const { sku, qty } of items) {
    const item = shopItems.find((i) => i.sku === sku)
    if (!item) throw Err.badRequest(`${sku} isn't in the shop.`)
    const line = lines.get(sku)
    if (line) line.qty += qty
    else lines.set(sku, { sku, name: item.name, qty, unitMinor: item.priceMinor })
  }
  const out = [...lines.values()]
  return { amountMinor: out.reduce((s, l) => s + l.qty * l.unitMinor, 0), lines: out }
}
