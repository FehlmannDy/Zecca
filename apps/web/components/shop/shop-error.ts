// Why a shop page could not load, in the shop's own words (UI.md §5.11: the shop is deliberately not Zecca).
// Only a switched-off shop reads as closed; a network or server hiccup can be retried.
import { isApiError } from '../../lib/api'

export type ShopTrouble = { kind: 'closed' } | { kind: 'missing' } | { kind: 'retry' }

export function shopTrouble(e: unknown): ShopTrouble {
  if (isApiError(e) && e.code === 'feature_off') return { kind: 'closed' }
  if (isApiError(e) && e.code === 'not_found') return { kind: 'missing' }
  return { kind: 'retry' }
}

export const basketCountLabel = (n: number) => (n === 1 ? '1 item' : `${n} items`)
