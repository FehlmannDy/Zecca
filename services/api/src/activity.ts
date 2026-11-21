// GET /v1/balance, GET /v1/activity (cursor pagination, newest first) and GET /v1/activity/:id (by activity or intent id).
import type { Hono } from 'hono'
import type { Core } from './core'
import { Err } from './errors'
import { mount } from './http'
import { activitiesOf, activitiesOfIntent, activityById, backfillCardActivity, getBalance, toActivity } from './books'
import { cardBalanceOf } from './connectors/card'

export function mountActivity(app: Hono, core: Core): void {
  mount(app, core, 'balance', ({ user }) => {
    const b = getBalance(core, user!.id)
    const cardMinor = core.settings.features.card ? cardBalanceOf(core, user!.id) : undefined
    return cardMinor === undefined ? b : { ...b, cardMinor }
  })

  mount(app, core, 'activity', ({ user, query }) => {
    const limit = query.limit ?? 20
    if (query.cursor === undefined || query.cursor === '') backfillCardActivity(core, user!.id)
    let beforeSeq: number | undefined
    if (query.cursor !== undefined && query.cursor !== '') {
      if (!/^\d{1,15}$/.test(query.cursor)) throw Err.badRequest('That page link is not valid.')
      beforeSeq = Number(query.cursor)
    }
    const rows = activitiesOf(core, user!.id, { beforeSeq, limit: limit + 1 })
    const page = rows.slice(0, limit)
    return {
      items: page.map((a) => toActivity(core, a)),
      ...(rows.length > limit ? { nextCursor: String(page[page.length - 1].seq) } : {}),
    }
  })

  mount(app, core, 'activityGet', ({ user, params }) => {
    const id = params.id
    const own = activityById(core, id)
    const row = own?.userId === user!.id ? own : activitiesOfIntent(core, id).find((a) => a.userId === user!.id)
    if (!row) throw Err.notFound("We couldn't find that payment.")
    return toActivity(core, row)
  })
}
