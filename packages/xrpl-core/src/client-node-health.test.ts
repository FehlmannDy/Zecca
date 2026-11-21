import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { createClient, type RawClient } from './client'

// Found in production on 21 Nov ~00:35 UTC: Devnet's hub was being upgraded (3.4.1 -> 3.5.0-rc5); a 3.4.1 node answered
// every request with amendmentBlocked. The load balancer sends a new connection to another node, so reconnect and retry.
const rippledError = (error: string) => Object.assign(new Error(error), { data: { error } })

function raw(answers: Array<'blocked' | 'notSynced' | 'ok'>) {
  const ee = new EventEmitter()
  let connected = false
  let connects = 0
  let i = 0
  const r: RawClient & { connects(): number } = {
    connects: () => connects,
    async request() {
      if (!connected) throw Object.assign(new Error('not connected'), { name: 'NotConnectedError' })
      const a = answers[Math.min(i++, answers.length - 1)]
      if (a === 'blocked') throw rippledError('amendmentBlocked')
      if (a === 'notSynced') throw rippledError('notSynced')
      return { result: { ledger_index: 42 } }
    },
    async connect() {
      connects++
      connected = true
      ee.emit('connected')
    },
    async disconnect() {
      connected = false
    },
    isConnected: () => connected,
    on: (e: string, cb: (...a: any[]) => void) => ee.on(e, cb),
  } as unknown as RawClient & { connects(): number }
  return r
}

describe('client: an unhealthy node (amendmentBlocked, notSynced) is left for another one', () => {
  it('reconnects and retries a read until a healthy node answers', async () => {
    const r = raw(['blocked', 'notSynced', 'ok'])
    const c = createClient('devnet', { raw: r, retryMs: 0 })
    expect(await c.ledgerIndex()).toBe(42)
    expect(r.connects()).toBe(3)
  })
  it('also retries a submit refused by a blocked node (it was never applied)', async () => {
    const r = raw(['blocked', 'ok'])
    const c = createClient('devnet', { raw: r, retryMs: 0 })
    const out = await c.request({ command: 'submit', tx_blob: 'AB' })
    expect(out.result).toBeTruthy()
    expect(r.connects()).toBe(2)
  })
  it('gives up after a few tries with the node error', async () => {
    const r = raw(['blocked'])
    const c = createClient('devnet', { raw: r, retryMs: 0 })
    await expect(c.ledgerIndex()).rejects.toThrow(/amendmentBlocked/)
  })
})
