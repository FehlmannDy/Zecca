import { describe, expect, it } from 'vitest'
import { pollMsFromEnv } from './env'

describe('POOL_POLL_MS', () => {
  it('accepts whole milliseconds of at least one second', () => {
    const logs: string[] = []
    expect(pollMsFromEnv('20000', (m) => logs.push(m))).toBe(20000)
    expect(pollMsFromEnv(' 1000 ', (m) => logs.push(m))).toBe(1000)
    expect(pollMsFromEnv(undefined, (m) => logs.push(m))).toBeUndefined()
    expect(pollMsFromEnv('', (m) => logs.push(m))).toBeUndefined()
    expect(logs).toEqual([])
  })

  it('falls back to the default, with a log line, for anything that would poll in a tight loop', () => {
    for (const bad of ['15s', '0', '500', '-3000', '1e4', 'NaN', '2000.5']) {
      const logs: string[] = []
      expect(pollMsFromEnv(bad, (m) => logs.push(m))).toBeUndefined()
      expect(logs.length).toBe(1)
      expect(logs[0]).toContain('POOL_POLL_MS')
    }
  })
})
