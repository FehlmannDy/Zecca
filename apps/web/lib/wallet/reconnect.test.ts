import { describe, expect, it } from 'vitest'
import { reconnectOnce } from './reconnect'

// Found on production: the connector's reconnect at mount was still running when an Approve called reconnect again,
// and xrpl-connect threw "Privy is already connected or connecting".
describe('reconnectOnce', () => {
  it('shares one reconnect between callers that overlap', async () => {
    let calls = 0
    let release!: (v: { address: string }) => void
    const manager = {
      account: null as null | { address: string },
      reconnect: () => {
        calls++
        if (calls > 1) return Promise.reject(new Error('Privy is already connected or connecting'))
        return new Promise<{ address: string }>((r) => (release = r))
      },
    }
    const a = reconnectOnce(manager)
    const b = reconnectOnce(manager)
    release({ address: 'rA' })
    expect(await a).toEqual({ address: 'rA' })
    expect(await b).toEqual({ address: 'rA' })
    expect(calls).toBe(1)
  })
  it('starts a new reconnect once the previous one settled', async () => {
    let calls = 0
    const manager = { account: null, reconnect: async () => ({ address: `r${++calls}` }) }
    await reconnectOnce(manager)
    await reconnectOnce(manager)
    expect(calls).toBe(2)
  })
})
