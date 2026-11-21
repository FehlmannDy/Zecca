import { describe, expect, it } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import type { Activity } from '@zecca/contracts'
import { activityTitle, activityWhen, activityLine, activityLineParts } from './activity'

const now = new Date(2026, 10, 21, 15, 0)
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()

describe('activity labels', () => {
  it('names the counterparty, or what the money was', () => {
    expect(activityTitle(fx.activity.sentCarla as Activity)).toBe('Carla Rossi')
    expect(activityTitle(fx.activity.welcome as Activity)).toBe('Demo credit')
    expect(activityTitle(fx.activity.topup as Activity)).toBe('Top up')
    expect(activityTitle({ ...(fx.activity.topup as Activity), kind: 'card_load', counterparty: undefined })).toBe('Card')
  })
  it('says when, in words', () => {
    expect(activityWhen(at(21, 9, 5), now)).toMatch(/^Today, 9:05\sAM$/)
    expect(activityWhen(at(20, 18, 30), now)).toMatch(/^Yesterday, 6:30\sPM$/)
    expect(activityWhen(at(12, 9), now)).toBe('Nov 12')
  })
  it('puts the note first, and says pending or failed in words', () => {
    expect(activityLine({ ...(fx.activity.sentCarla as Activity), at: at(21, 9) }, now)).toMatch(/^Dinner · Today/)
    expect(activityLine({ ...(fx.activity.coffee as Activity), at: at(21, 9) }, now)).toMatch(/Pending/)
    expect(activityLine({ ...(fx.activity.coffee as Activity), status: 'failed', at: at(21, 9) }, now)).toMatch(/Failed/)
    expect(activityLine({ ...(fx.activity.welcome as Activity), at: at(21, 9) }, now)).toMatch(/^Welcome to Zecca · /)
  })
})

describe('activity line parts', () => {
  it('keeps the note apart from the time, so only the note is cut on a narrow row', () => {
    expect(activityLineParts({ ...(fx.activity.sentCarla as Activity), at: at(21, 9) }, now)).toEqual({ note: 'Dinner', when: expect.stringMatching(/^Today, 9:00\sAM$/) })
    expect(activityLineParts({ ...(fx.activity.welcome as Activity), at: at(21, 9) }, now).note).toBe('Welcome to Zecca')
    expect(activityLineParts({ ...(fx.activity.coffee as Activity), at: at(21, 9) }, now).when).toMatch(/ · Pending$/)
    expect(activityLineParts({ ...(fx.activity.topup as Activity), note: undefined, at: at(21, 9) }, now).note).toBeUndefined()
  })
})
