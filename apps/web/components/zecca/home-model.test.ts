import { describe, expect, it } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import type { PublicConfig } from '@zecca/contracts'
import { homeLinks } from './home-model'

const cfg = (o: { ramp?: boolean; identity?: boolean; demoMode?: boolean } = {}): PublicConfig => {
  const base = fx.config as PublicConfig
  return { ...base, demoMode: o.demoMode ?? false, features: { ...base.features, ramp: o.ramp ?? false, identity: o.identity ?? false } }
}

describe('home links', () => {
  it('shows Top up when the ramp is on, or in demo mode (demo credit)', () => {
    expect(homeLinks(cfg({ ramp: true })).topup).toBe(true)
    expect(homeLinks(cfg({ demoMode: true })).topup).toBe(true)
    expect(homeLinks(cfg()).topup).toBe(false)
  })

  it('keeps Top up in place while the config is loading (no jump in the action row)', () => {
    expect(homeLinks(undefined).topup).toBe(true)
  })

  it('makes "Verify to lift it" a link to the identity check when identity is on', () => {
    expect(homeLinks(cfg({ identity: true })).verifyHref).toBe('/app/identity')
    expect(homeLinks(cfg()).verifyHref).toBeUndefined()
    expect(homeLinks(undefined).verifyHref).toBeUndefined()
  })
})
