// Demo shop (SPEC §4.14). Wave 2 (agent G) drops the real module in here; until then the routes are off.
// The shop's merchant account is seeded by seedDemoShop (src/seed.ts).
import type { Hono } from 'hono'
import type { Core } from '../core'
import { Err } from '../errors'
import { mount } from '../http'

export function mountDemoShop(app: Hono, core: Core): void {
  for (const name of ['shopItems', 'shopOrderCreate', 'shopOrderGet'] as const) {
    mount(app, core, name, () => {
      throw Err.featureOff()
    })
  }
}
