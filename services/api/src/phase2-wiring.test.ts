import { describe, expect, it } from 'vitest'
import { routes, type RouteDef } from '@zecca/contracts'
import { makeHarness } from './testing/harness'

// Phase-2 connectors are mounted by createApp; each stays dark (404 feature_off) until its flag is on.
const phase2 = (Object.entries(routes) as [string, RouteDef][]).filter(([, r]) => r.phase === 2 && r.feature && r.feature !== 'demoShop')
const path = (p: string) => p.replace(/:([a-zA-Z]+)/g, 'x_1')

describe('phase-2 connectors are wired into the API', () => {
  it('every phase-2 route answers feature_off while its flag is off', async () => {
    const h = makeHarness({ extra: { connectors: true } })
    const ana = await h.signUp('ana')
    for (const [name, r] of phase2) {
      const res = await h.json(r.method, path(r.path), { token: ana.token, body: r.method === 'POST' ? {} : undefined })
      expect(res.body?.error?.code, `${name} ${r.method} ${r.path}`).toBe('feature_off')
    }
  })
  it('every phase-2 route of the contract table is registered on the app', () => {
    const h = makeHarness({ extra: { connectors: true } })
    const registered = new Set((h.app as unknown as { routes: { method: string; path: string }[] }).routes.map((r) => `${r.method} ${r.path}`))
    const missing = phase2.filter(([, r]) => !registered.has(`${r.method} ${r.path}`)).map(([n, r]) => `${n} ${r.method} ${r.path}`)
    expect(missing).toEqual([])
  })
})
