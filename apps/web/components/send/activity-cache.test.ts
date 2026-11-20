import { describe, expect, it } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import { cachedActivity, rememberActivities } from './activity-cache'

describe('activity cache', () => {
  it('gives a row back by activity id or intent id to the user whose list showed it', () => {
    rememberActivities('usr_ana', [fx.activity.sentCarla])
    expect(cachedActivity('usr_ana', fx.activity.sentCarla.id)).toBe(fx.activity.sentCarla)
    expect(cachedActivity('usr_ana', fx.activity.sentCarla.intentId)).toBe(fx.activity.sentCarla)
  })

  it('never shows one user’s activity to the next one signed in on the same tab', () => {
    rememberActivities('usr_ana', [fx.activity.sentCarla])
    expect(cachedActivity('usr_bruno', fx.activity.sentCarla.id)).toBeUndefined()
    expect(cachedActivity(undefined, fx.activity.sentCarla.id)).toBeUndefined()
    rememberActivities('usr_bruno', [fx.activity.coffee])
    expect(cachedActivity('usr_ana', fx.activity.sentCarla.id)).toBeUndefined()
    expect(cachedActivity('usr_bruno', fx.activity.sentCarla.id)).toBeUndefined()
    expect(cachedActivity('usr_bruno', fx.activity.coffee.id)).toBe(fx.activity.coffee)
  })
})
