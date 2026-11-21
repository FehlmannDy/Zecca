import { describe, expect, it } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import type { User } from '@zecca/contracts'
import { hasSpaceSwitch, spaceOf, spaceTabs } from './space-switch-model'

const ana = fx.users.ana as User
const bruno = fx.users.bruno as User

describe('space switch', () => {
  it('knows the space from the path', () => {
    expect(spaceOf('/app')).toBe('personal')
    expect(spaceOf('/app/send')).toBe('personal')
    expect(spaceOf('/merchant')).toBe('business')
    expect(spaceOf('/merchant/charge')).toBe('business')
    expect(spaceOf('/merchant/pair')).toBe('business')
    expect(spaceOf('/merchantile')).toBe('personal')
  })
  it('shows Personal and Business, in that order, to someone with a business', () => {
    const tabs = spaceTabs(bruno, '/app/more')
    expect(tabs?.map((t) => [t.label, t.href])).toEqual([
      ['Personal', '/app'],
      ['Business', '/merchant'],
    ])
  })
  it('marks the space you are in as current, on every page of it', () => {
    const current = (path: string) => spaceTabs(bruno, path)?.filter((t) => t.current).map((t) => t.space)
    expect(current('/app')).toEqual(['personal'])
    expect(current('/app/activity')).toEqual(['personal'])
    expect(current('/merchant')).toEqual(['business'])
    expect(current('/merchant/sales')).toEqual(['business'])
  })
  it('shows nothing to a personal account or before the session is known', () => {
    expect(spaceTabs(ana, '/app')).toBeNull()
    expect(spaceTabs(ana, '/merchant')).toBeNull()
    expect(spaceTabs(undefined, '/app')).toBeNull()
  })
  it('tells the header when the switch is there (it then shows the logo mark alone on a phone)', () => {
    expect(hasSpaceSwitch(bruno)).toBe(true)
    expect(hasSpaceSwitch(ana)).toBe(false)
    expect(hasSpaceSwitch(null)).toBe(false)
  })
})
