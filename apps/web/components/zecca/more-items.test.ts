import { describe, expect, it } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import type { PublicConfig, User } from '@zecca/contracts'
import { moreItems } from './more-items'

const cfg = (features: Partial<PublicConfig['features']> = {}) => ({ ...(fx.config as PublicConfig), features: { ...(fx.config as PublicConfig).features, ...features } })
const labels = (c: PublicConfig, u: User) => moreItems(c, u).map((i) => i.label)

describe('More menu', () => {
  it('shows only what is switched on', () => {
    const off = labels(cfg({ card: false, earn: false, market: false, identity: false, proofs: false, passkey: false }), fx.users.ana as User)
    expect(off).toEqual(['Activity', 'Get paid', 'Add money', 'How Zecca works'])
    const on = labels(cfg({ card: true, earn: true, market: true, identity: true, proofs: true, passkey: true }), fx.users.ana as User)
    expect(on).toEqual(['Activity', 'Get paid', 'Add money', 'Card', 'Earn', 'Metals', 'Verify your identity', 'Statements', 'Face ID', 'How Zecca works'])
  })
  it('a verified person sees "Identity verified", a merchant can switch to the business space', () => {
    const items = moreItems(cfg({ identity: true }), { ...(fx.users.bruno as User), tier: 1 })
    expect(items.map((i) => i.label)).toContain('Identity verified')
    expect(items.find((i) => i.label === 'Switch to Caffè Bruno')).toEqual({ href: '/merchant', label: 'Switch to Caffè Bruno', hint: 'Your business space' })
  })
  it('top-up shows when the ramp is on or in demo mode', () => {
    expect(labels({ ...cfg({ ramp: false }), demoMode: false }, fx.users.ana as User)).not.toContain('Add money')
  })
  it('says what Add money does: a card with the ramp on, demo credit without it', () => {
    const hint = (c: PublicConfig) => moreItems(c, fx.users.ana as User).find((i) => i.label === 'Add money')?.hint
    expect(hint({ ...cfg({ ramp: true }), demoMode: true })).toBe('Top up with a card')
    expect(hint({ ...cfg({ ramp: false }), demoMode: true })).toBe('Add demo credit')
  })
  it('never promises more than the sandbox card does', () => {
    const card = moreItems(cfg({ card: true }), fx.users.ana as User).find((i) => i.label === 'Card')
    expect(card?.hint).toBe('A sandbox card for test purchases')
  })
})
