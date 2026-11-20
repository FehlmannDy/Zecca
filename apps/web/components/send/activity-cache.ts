// What the activity list last showed, so the detail page can draw at once while it fetches the fresh row
// (there is no GET /v1/activity/:id yet). In memory only, for this tab, and for one user: sign-out does not reload
// the page, so rows are kept with the user they belong to and dropped when someone else's arrive.
import type { Activity } from '@zecca/contracts'
import { findActivity } from './ledger-view'

let owner: string | undefined
const seen = new Map<string, Activity>()

export function rememberActivities(userId: string, list: readonly Activity[]): void {
  if (userId !== owner) {
    seen.clear()
    owner = userId
  }
  for (const a of list) seen.set(a.id, a)
}

export function cachedActivity(userId: string | undefined, id: string): Activity | undefined {
  if (!userId || userId !== owner) return undefined
  return findActivity([...seen.values()], id)
}
