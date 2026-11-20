import { describe, expect, it } from 'vitest'
import { Activity } from '@zecca/contracts'
import { makeHarness } from './testing/harness'

describe('GET /v1/activity/:id', () => {
  it('returns one of my activities by activity id or intent id, and never another person\'s', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    const carla = await h.signUp('carla')
    const list = await h.json('GET', '/v1/activity', { token: ana.token })
    const first = list.body.items[0]
    const byId = await h.json('GET', `/v1/activity/${first.id}`, { token: ana.token })
    expect(byId.status).toBe(200)
    expect(Activity.parse(byId.body).id).toBe(first.id)
    const byIntent = await h.json('GET', `/v1/activity/${first.intentId}`, { token: ana.token })
    expect(byIntent.body.id).toBe(first.id)
    const other = await h.json('GET', `/v1/activity/${first.id}`, { token: carla.token })
    expect(other.status).toBe(404)
  })
})
