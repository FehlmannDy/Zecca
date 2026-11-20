// Which activity items go on a statement. Only completed ones (the API refuses the others); at most what the API accepts.
import type { Activity } from '@zecca/contracts'

/** DisclosureRequest.activityIds max (packages/contracts api.ts). */
export const MAX_LINES = 200

export const selectable = (items: Activity[]) => items.filter((a) => a.status === 'done')

export function toggle(sel: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(sel)
  if (next.has(id)) next.delete(id)
  else if (next.size < MAX_LINES) next.add(id)
  return next
}

/** Selects every selectable item (up to MAX_LINES), or clears when they are all selected already. */
export function toggleAll(sel: ReadonlySet<string>, items: Activity[]): Set<string> {
  const ids = selectable(items)
    .map((a) => a.id)
    .slice(0, MAX_LINES)
  return ids.length > 0 && ids.every((id) => sel.has(id)) ? new Set() : new Set(ids)
}
