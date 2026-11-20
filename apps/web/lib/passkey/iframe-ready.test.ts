import { describe, expect, it, vi } from 'vitest'
import { patchPrivyIframeReady } from './iframe-ready'

type Poster = { postMessage(message: unknown, origin: string, transfer?: unknown): void; reload(): void }

function fakeAdapter() {
  const sent: string[] = []
  const client = {
    poster: null as Poster | null,
    setMessagePoster(p: Poster) {
      this.poster = p
    },
  }
  const session = {
    client: undefined as typeof client | undefined,
    async ensureClient() {
      this.client ??= client
      return this.client
    },
  }
  const raw: Poster = { postMessage: (m) => sent.push(String(m)), reload: () => {} }
  return { adapter: { session }, client, sent, raw }
}

const ready = (id: string) => JSON.stringify({ id, event: 'privy:iframe:ready', data: {} })

describe('patchPrivyIframeReady', () => {
  it('repeats the readiness ping until the iframe answers it', async () => {
    vi.useFakeTimers()
    const f = fakeAdapter()
    const win = new EventTarget()
    expect(patchPrivyIframeReady(f.adapter, { win, everyMs: 250 })).toBe(true)
    const c = await f.adapter.session.ensureClient()
    c.setMessagePoster(f.raw)
    c.poster!.postMessage(ready('id-7'), '*')
    expect(f.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sent).toHaveLength(5)
    expect(new Set(f.sent)).toEqual(new Set([ready('id-7')]))
    win.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ id: 'id-7', event: 'privy:iframe:ready', response: {} }) }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.sent).toHaveLength(5)
    vi.useRealTimers()
  })

  it('gives up after maxMs, and passes every other message through once', async () => {
    vi.useFakeTimers()
    const f = fakeAdapter()
    patchPrivyIframeReady(f.adapter, { win: new EventTarget(), everyMs: 250, maxMs: 1000 })
    const c = await f.adapter.session.ensureClient()
    c.setMessagePoster(f.raw)
    c.poster!.postMessage(JSON.stringify({ id: 'id-1', event: 'privy:user-signer:sign', data: {} }), '*')
    expect(f.sent).toHaveLength(1)
    c.poster!.postMessage(ready('id-2'), '*')
    await vi.advanceTimersByTimeAsync(5000)
    expect(f.sent.filter((m) => m.includes('id-2')).length).toBe(4)
    vi.useRealTimers()
  })

  it('is a no-op on an adapter without the private session', () => {
    expect(patchPrivyIframeReady({}, { win: new EventTarget() })).toBe(false)
  })

  it('patches once', async () => {
    const f = fakeAdapter()
    expect(patchPrivyIframeReady(f.adapter, { win: new EventTarget() })).toBe(true)
    expect(patchPrivyIframeReady(f.adapter, { win: new EventTarget() })).toBe(true)
    const c = await f.adapter.session.ensureClient()
    c.setMessagePoster(f.raw)
    c.poster!.postMessage(JSON.stringify({ id: 'x', event: 'privy:wallets:rpc' }), '*')
    expect(f.sent).toHaveLength(1)
  })
})
