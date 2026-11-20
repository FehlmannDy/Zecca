// Ramp connector (MoonPay, SPEC §4.5). Wave 2 (agent H) drops the real module in here; until then every route is off.
import type { Hono } from 'hono'
import type { Core } from '../../core'
import { Err } from '../../errors'
import { mount } from '../../http'

export function mountRamp(app: Hono, core: Core): void {
  mount(app, core, 'rampSession', () => {
    throw Err.featureOff()
  })
  mount(app, core, 'rampSign', () => {
    throw Err.featureOff()
  })
  mount(app, core, 'moonpayWebhook', () => {
    throw Err.featureOff()
  })
}
