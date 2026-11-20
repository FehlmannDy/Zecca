// Sette Archi's basket: sku -> quantity, kept in the browser. Prices come from GET /v1/demo/shop/items (integer cents).
export type Basket = Record<string, number>
export type CatalogItem = { sku: string; name: string; priceMinor: number; description?: string }

const MAX_QTY = 20

export function setQty(b: Basket, sku: string, qty: number): Basket {
  const next = { ...b }
  const q = Math.min(MAX_QTY, Math.floor(qty))
  if (q > 0) next[sku] = q
  else delete next[sku]
  return next
}

export const addToBasket = (b: Basket, sku: string) => setQty(b, sku, (b[sku] ?? 0) + 1)

export function basketLines(b: Basket, items: CatalogItem[]) {
  const lines = items.filter((i) => b[i.sku]).map((i) => ({ ...i, qty: b[i.sku], lineMinor: b[i.sku] * i.priceMinor }))
  return { lines, totalMinor: lines.reduce((s, l) => s + l.lineMinor, 0), count: lines.reduce((s, l) => s + l.qty, 0) }
}

export const toOrderItems = (b: Basket) => Object.entries(b).map(([sku, qty]) => ({ sku, qty }))

export function parseBasket(raw: string | null): Basket {
  try {
    const v: unknown = raw ? JSON.parse(raw) : {}
    if (!v || typeof v !== 'object') return {}
    return Object.fromEntries(Object.entries(v).filter(([, q]) => Number.isInteger(q) && (q as number) > 0 && (q as number) <= MAX_QTY)) as Basket
  } catch {
    return {}
  }
}
