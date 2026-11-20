// What the activity list last showed, so the detail page can draw at once while it fetches the fresh row
// (there is no GET /v1/activity/:id yet). In memory only, for this tab.
import type { Activity } from '@zecca/contracts'
import { findActivity } from './ledger-view'

const seen = new Map<string, Activity>()

export function rememberActivities(list: readonly Activity[]): void {
  for (const a of list) seen.set(a.id, a)
}

export function cachedActivity(id: string): Activity | undefined {
  return findActivity([...seen.values()], id)
}
