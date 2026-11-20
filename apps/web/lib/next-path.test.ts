import { describe, expect, it } from 'vitest'
import { safeNextPath } from './next-path'

describe('?next= after sign-up', () => {
  it('keeps same-origin paths', () => {
    expect(safeNextPath('/pay/pr_coffee')).toBe('/pay/pr_coffee')
    expect(safeNextPath('/app/send?to=carla')).toBe('/app/send?to=carla')
  })
  it('falls back to /app for anything that could leave the site', () => {
    for (const bad of [null, '', '/', '//evil.example', '/\\evil.example', 'https://evil.example', 'javascript:alert(1)', '/x:y', 'pay/abc'])
      expect(safeNextPath(bad)).toBe('/app')
  })
})
