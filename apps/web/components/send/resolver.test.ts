import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicProfile } from '@zecca/contracts'
import { createResolver, lookupQuery, type ResolveAnswer, type ResolverState } from './resolver'

const carla: PublicProfile = { id: 'usr_carla', handle: 'carla', displayName: 'Carla Rossi', isMerchant: false }
const ana: PublicProfile = { id: 'usr_ana', handle: 'ana', displayName: 'Ana Ferri', isMerchant: false }

function setup(answer: (q: string) => Promise<ResolveAnswer>, selfId = ana.id) {
  const states: ResolverState[] = []
  const resolve = vi.fn((q: string, _signal: AbortSignal) => answer(q))
  const r = createResolver({ resolve, selfId, delayMs: 300, onChange: (s) => states.push(s) })
  return { r, resolve, states, last: () => states[states.length - 1] }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('lookupQuery', () => {
  it('trims and keeps what the API understands', () => {
    expect(lookupQuery('  @carla ')).toBe('@carla')
    expect(lookupQuery('carla@example.com')).toBe('carla@example.com')
  })
  it('returns null while the text is too short to be a handle, phone or email', () => {
    expect(lookupQuery('')).toBeNull()
    expect(lookupQuery('ca')).toBeNull()
    expect(lookupQuery('@ca')).toBeNull()
    expect(lookupQuery('   ')).toBeNull()
  })
  it('returns null beyond the API limit', () => {
    expect(lookupQuery('a'.repeat(121))).toBeNull()
  })
})

describe('createResolver', () => {
  it('waits for the typing to pause, then resolves the latest text once', async () => {
    const { r, resolve, last } = setup(async () => ({ kind: 'zecca', profile: carla }))
    r.input('car')
    r.input('carl')
    r.input('carla')
    expect(last()).toEqual({ kind: 'waiting', q: 'carla' })
    await vi.advanceTimersByTimeAsync(299)
    expect(resolve).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0]).toBe('carla')
    expect(last()).toEqual({ kind: 'found', q: 'carla', profile: carla })
  })

  it('goes idle on short text without calling the API', async () => {
    const { r, resolve, last } = setup(async () => ({ kind: 'unknown' }))
    r.input('ca')
    await vi.advanceTimersByTimeAsync(1000)
    expect(resolve).not.toHaveBeenCalled()
    expect(last()).toEqual({ kind: 'idle' })
  })

  it('ignores an answer that arrives after the text changed', async () => {
    let release!: (a: ResolveAnswer) => void
    const slow = new Promise<ResolveAnswer>((res) => (release = res))
    const { r, last } = setup((q) => (q === 'carl' ? slow : Promise.resolve({ kind: 'zecca', profile: carla })))
    r.input('carl')
    await vi.advanceTimersByTimeAsync(300)
    r.input('carla')
    await vi.advanceTimersByTimeAsync(300)
    expect(last()).toEqual({ kind: 'found', q: 'carla', profile: carla })
    release({ kind: 'unknown' })
    await vi.advanceTimersByTimeAsync(0)
    expect(last()).toEqual({ kind: 'found', q: 'carla', profile: carla })
  })

  it('aborts the request in flight when the text changes', async () => {
    const signals: AbortSignal[] = []
    const states: ResolverState[] = []
    const r = createResolver({
      resolve: (_q, signal) => {
        signals.push(signal)
        return new Promise(() => {})
      },
      delayMs: 300,
      onChange: (s) => states.push(s),
    })
    r.input('carl')
    await vi.advanceTimersByTimeAsync(300)
    r.input('carla')
    expect(signals[0].aborted).toBe(true)
  })

  it('says when the person found is the user', async () => {
    const { r, last } = setup(async () => ({ kind: 'zecca', profile: ana }))
    r.input('ana@example.com')
    await vi.advanceTimersByTimeAsync(300)
    expect(last()).toEqual({ kind: 'self', q: 'ana@example.com' })
  })

  it('passes external and unknown through', async () => {
    const ext = setup(async () => ({ kind: 'external', address: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH' }))
    ext.r.input('rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH')
    await vi.advanceTimersByTimeAsync(300)
    expect(ext.last()).toEqual({ kind: 'external', q: 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH' })

    const unk = setup(async () => ({ kind: 'unknown' }))
    unk.r.input('nobody')
    await vi.advanceTimersByTimeAsync(300)
    expect(unk.last()).toEqual({ kind: 'unknown', q: 'nobody' })
  })

  it('reports an error with its message', async () => {
    const { r, last } = setup(async () => {
      throw new Error("Can't reach Zecca right now.")
    })
    r.input('carla')
    await vi.advanceTimersByTimeAsync(300)
    expect(last()).toEqual({ kind: 'error', q: 'carla', message: "Can't reach Zecca right now." })
  })

  it('does not look up the same text twice in a row', async () => {
    const { r, resolve } = setup(async () => ({ kind: 'zecca', profile: carla }))
    r.input('carla')
    await vi.advanceTimersByTimeAsync(300)
    r.input('carla ')
    await vi.advanceTimersByTimeAsync(300)
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it('looks the same text up again after an error', async () => {
    let down = true
    const { r, resolve, last } = setup(async () => {
      if (down) throw new Error("Can't reach Zecca right now.")
      return { kind: 'zecca', profile: carla }
    })
    r.input('carla')
    await vi.advanceTimersByTimeAsync(300)
    expect(last().kind).toBe('error')
    down = false
    r.input('carla')
    expect(last()).toEqual({ kind: 'waiting', q: 'carla' })
    await vi.advanceTimersByTimeAsync(300)
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(last()).toEqual({ kind: 'found', q: 'carla', profile: carla })
  })

  it('stops after dispose', async () => {
    const { r, resolve } = setup(async () => ({ kind: 'zecca', profile: carla }))
    r.input('carla')
    r.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(resolve).not.toHaveBeenCalled()
  })
})
