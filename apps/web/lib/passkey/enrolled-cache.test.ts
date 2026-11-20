import { describe, expect, it, vi } from 'vitest'
import { createEnrolledCache } from './enrolled-cache'

const ANA = 'rAnaAnaAnaAnaAnaAnaAnaAnaAnaAnaAna'
const CARLA = 'rCarlaCarlaCarlaCarlaCarlaCarlaCa'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

describe('createEnrolledCache', () => {
  it('does not hand one person’s Face ID to the next person signed in in the same tab', () => {
    const cache = createEnrolledCache()
    cache.set(ANA, true)
    expect(cache.get(ANA)).toBe(true)
    expect(cache.get(CARLA)).toBeNull()
    expect(cache.get(null)).toBeNull()
    expect(cache.get(undefined)).toBeNull()
  })

  it('does not let a cached "not enrolled" hide another person’s Face ID', () => {
    const cache = createEnrolledCache()
    cache.set(CARLA, false)
    expect(cache.get(CARLA)).toBe(false)
    expect(cache.get(ANA)).toBeNull()
  })

  it('tells subscribers when the answer changes, until they unsubscribe', () => {
    const cache = createEnrolledCache()
    const fn = vi.fn()
    const off = cache.subscribe(fn)
    cache.set(ANA, true)
    expect(fn).toHaveBeenCalledTimes(1)
    off()
    cache.set(ANA, false)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('refresh stores what Privy says for the person signed in', async () => {
    const cache = createEnrolledCache()
    const fn = vi.fn()
    cache.subscribe(fn)
    await expect(cache.refresh(ANA, async () => true, () => ANA)).resolves.toBe(true)
    expect(cache.get(ANA)).toBe(true)
    expect(fn).toHaveBeenCalled()
  })

  it('refresh drops the answer when someone else signed in while Privy answered', async () => {
    const cache = createEnrolledCache()
    let current: string | null = ANA
    const answer = deferred<boolean | null>()
    const pending = cache.refresh(ANA, () => answer.promise, () => current)
    current = CARLA // Ana signed out, Carla signed in; Privy now answers for Carla's account
    answer.resolve(true)
    await expect(pending).resolves.toBeNull()
    expect(cache.get(ANA)).toBeNull()
    expect(cache.get(CARLA)).toBeNull()
  })

  it('refresh keeps the answer unknown when Privy cannot tell yet', async () => {
    const cache = createEnrolledCache()
    await expect(cache.refresh(ANA, async () => null, () => ANA)).resolves.toBeNull()
    expect(cache.get(ANA)).toBeNull()
  })

  it('asks Privy once while a read for the same person is in flight, and again after a failure', async () => {
    const cache = createEnrolledCache()
    const answer = deferred<boolean | null>()
    const read = vi.fn(() => answer.promise)
    const a = cache.refresh(ANA, read, () => ANA)
    const b = cache.refresh(ANA, read, () => ANA)
    expect(read).toHaveBeenCalledTimes(1)
    answer.reject(new Error('offline'))
    await expect(a).rejects.toThrow('offline')
    await expect(b).rejects.toThrow('offline')
    await expect(cache.refresh(ANA, async () => false, () => ANA)).resolves.toBe(false)
    expect(cache.get(ANA)).toBe(false)
  })

  it('asks again after a read that throws straight away', async () => {
    const cache = createEnrolledCache()
    const throwsNow = () => {
      throw new Error('Privy runs in the browser only')
    }
    await expect(cache.refresh(ANA, throwsNow, () => ANA)).rejects.toThrow('Privy runs in the browser only')
    await expect(cache.refresh(ANA, async () => true, () => ANA)).resolves.toBe(true)
  })

  it('does not share an in-flight read between two people', async () => {
    const cache = createEnrolledCache()
    let current: string | null = ANA
    const anaAnswer = deferred<boolean | null>()
    const anaRead = cache.refresh(ANA, () => anaAnswer.promise, () => current)
    current = CARLA
    const carlaRead = vi.fn(async () => false)
    await expect(cache.refresh(CARLA, carlaRead, () => current)).resolves.toBe(false)
    expect(carlaRead).toHaveBeenCalledTimes(1)
    anaAnswer.resolve(true)
    await expect(anaRead).resolves.toBeNull()
    expect(cache.get(CARLA)).toBe(false)
  })
})
