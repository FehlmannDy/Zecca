import { describe, expect, it } from 'vitest'
import { ZeccaEvent } from '@zecca/contracts'
import { makeHarness } from './testing/harness'

/** Reads SSE messages from a streaming Response until `until` matches (or the timeout), then cancels the stream. */
async function readEvents(res: Response, until: (events: ZeccaEvent[]) => boolean, ms = 3000): Promise<ZeccaEvent[]> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  const events: ZeccaEvent[] = []
  let buf = ''
  const end = Date.now() + ms
  try {
    while (!until(events)) {
      if (Date.now() > end) throw new Error(`timed out; got ${events.map((e) => e.type).join(',')}`)
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: false }>((r) => setTimeout(() => r({ value: undefined, done: false }), 50)),
      ])
      if (done) break
      if (value) buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const ev = /^event: (.*)$/m.exec(block)?.[1]
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n')
        const parsed = ZeccaEvent.parse(JSON.parse(data))
        expect(parsed.type).toBe(ev)
        events.push(parsed)
      }
    }
  } finally {
    await reader.cancel()
  }
  return events
}

describe('events (SSE)', () => {
  it('GET /v1/events streams the current balance, then balance/intent/activity events of a payment, every one valid', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    const carla = await h.signUp('carla')
    const res = await h.call('GET', '/v1/events', { token: carla.token })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/)
    const t = await h.json('POST', '/v1/transfers', { token: ana.token, body: { to: carla.user.id, amountMinor: 1200 } })
    await h.submit(ana, t.body.prepared)
    const events = await readEvents(res, (es) => es.some((e) => e.type === 'balance.updated' && e.data.availableMinor === 6200))
    expect(events[0]).toMatchObject({ type: 'balance.updated', data: { availableMinor: 5000 } })
    const types = events.map((e) => e.type)
    expect(types).toContain('intent.updated')
    expect(types).toContain('activity.created')
    expect(events.some((e) => e.type === 'balance.updated' && e.data.pendingMinor === 1200)).toBe(true)
  })

  it('accepts ?token= (EventSource cannot set headers) and refuses no token', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    const res = await h.call('GET', `/v1/events?token=${encodeURIComponent(ana.token)}`)
    expect(res.status).toBe(200)
    await readEvents(res, (es) => es.length >= 1)
    expect((await h.call('GET', '/v1/events')).status).toBe(401)
    // ?token= is only for streams.
    expect((await h.call('GET', `/v1/me?token=${encodeURIComponent(ana.token)}`)).status).toBe(401)
  })

  it('the public request stream tells the pay page when the request is paid; the merchant stream too', async () => {
    const h = makeHarness()
    const bruno = await h.signUp('caffebruno', { role: 'merchant', businessName: 'Caffè Bruno' })
    const ana = await h.signUp('ana')
    const pr = (await h.json('POST', '/v1/payment-requests', { token: bruno.token, body: { amountMinor: 450 } })).body
    const pub = await h.call('GET', `/v1/payment-requests/${pr.id}/events`)
    expect(pub.status).toBe(200)
    const merchant = await h.call('GET', '/v1/events', { token: bruno.token })
    const p = await h.json('POST', `/v1/payment-requests/${pr.id}/pay`, { token: ana.token })
    await h.submit(ana, p.body.prepared)
    const paid = (es: ZeccaEvent[]) => es.some((e) => e.type === 'payment_request.updated' && e.data.status === 'paid')
    const pubEvents = await readEvents(pub, paid)
    expect(pubEvents[0]).toMatchObject({ type: 'payment_request.updated', data: { id: pr.id, status: 'created' } })
    const mEvents = await readEvents(merchant, paid)
    expect(mEvents.some((e) => e.type === 'activity.created' && e.data.direction === 'in')).toBe(true)
  })

  it('unsubscribes when the client goes away', async () => {
    const h = makeHarness()
    const ana = await h.signUp('ana')
    const res = await h.call('GET', '/v1/events', { token: ana.token })
    expect(h.app.core.bus.listenerCount('user', ana.user.id)).toBe(1)
    await readEvents(res, (es) => es.length >= 1)
    await new Promise((r) => setTimeout(r, 10))
    expect(h.app.core.bus.listenerCount('user', ana.user.id)).toBe(0)
  })
})
