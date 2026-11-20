// GET /v1/balance and GET /v1/activity (cursor pagination, newest first).
import type { Hono } from 'hono'
import type { Core } from './core'
import { Err } from './errors'
import { mount } from './http'
import { activitiesOf, getBalance, toActivity } from './books'

export function mountActivity(app: Hono, core: Core): void {
  mount(app, core, 'balance', ({ user }) => getBalance(core, user!.id))

  mount(app, core, 'activity', ({ user, query }) => {
    const limit = query.limit ?? 20
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
}
