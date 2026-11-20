// POST /v1/transfers (p2p intent + prepared deposit to the pool) and GET /v1/transfers/:id.
import type { Hono } from 'hono'
import type { Core } from './core'
import { Err } from './errors'
import { mount } from './http'
import { users } from './users'
import { intents, toIntent } from './intents/repo'
import { createSendIntent } from './intents/flow'

export function mountTransfers(app: Hono, core: Core): void {
  mount(app, core, 'transferCreate', async ({ user, body }) => {
    const recipient = users.byId(core, body.to)
    if (!recipient || recipient.status !== 'active') throw Err.notFound("We couldn't find that person.")
    const note = body.note?.trim() || undefined
    return createSendIntent(core, { sender: user!, recipient, kind: 'p2p', amountMinor: body.amountMinor, feeMinor: 0, note })
  })

  mount(app, core, 'transferGet', ({ user, params }) => {
    const i = intents.byId(core, params.id)
    if (!i || (i.fromUserId !== user!.id && i.toUserId !== user!.id)) throw Err.notFound("We couldn't find that payment.")
    return toIntent(i)
  })
}
