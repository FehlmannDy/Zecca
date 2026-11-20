// POST /v1/dev/credit (DEMO_MODE=1 only, 404 otherwise): a demo top-up through SPEC §2.7, exactly like a real one.
import type { Hono } from 'hono'
import type { Core } from './core'
import { mount } from './http'
import { startTopup } from './intents/flow'

export function mountDev(app: Hono, core: Core): void {
  mount(app, core, 'devCredit', ({ user, body }) => {
    core.rateLimit(user!.address)
    return startTopup(core, user!, body.amountMinor, { note: 'Demo credit' })
  })
}
