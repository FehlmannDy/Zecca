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
  it('a verified person sees "Identity verified", a merchant sees the business space', () => {
    const items = moreItems(cfg({ identity: true }), { ...(fx.users.bruno as User), tier: 1 })
    expect(items.map((i) => i.label)).toContain('Identity verified')
    expect(items.find((i) => i.label === 'Caffè Bruno')?.href).toBe('/merchant')
  })
  it('top-up shows when the ramp is on or in demo mode', () => {
    expect(labels({ ...cfg({ ramp: false }), demoMode: false }, fx.users.ana as User)).not.toContain('Add money')
  })
})
