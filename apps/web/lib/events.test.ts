import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import { createEventStream } from './events'

class FakeES {
  static all: FakeES[] = []
  readyState = 0
  listeners = new Map<string, ((e: { data: string }) => void)[]>()
  closed = false
  constructor(readonly url: string) {
    FakeES.all.push(this)
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  fire(type: string, data?: unknown) {
    if (type === 'open') this.readyState = 1
    this.listeners.get(type)?.forEach((f) => f({ data: typeof data === 'string' ? data : JSON.stringify(data) }))
  }
}

beforeEach(() => {
  FakeES.all = []
  vi.useFakeTimers()
})
afterEach(() => vi.useRealTimers())

describe('event stream', () => {
  it('parses named events with the ZeccaEvent schema and ignores pings and junk', () => {
    const onEvent = vi.fn()
    const s = createEventStream({ url: () => 'http://api/v1/events?token=t', onEvent, onPoll: vi.fn(), EventSourceImpl: FakeES as never })
    const es = FakeES.all[0]
    es.fire('open')
    es.fire('balance.updated', fx.events[0])
    es.fire('activity.created', fx.events[3])
    es.fire('ping', { type: 'ping', data: {}, at: fx.events[0].at })
    es.fire('balance.updated', '{oops')
    es.fire('balance.updated', { type: 'balance.updated', data: { availableMinor: -1 } })
    expect(onEvent.mock.calls.map((c) => c[0].type)).toEqual(['balance.updated', 'activity.created'])
    s.close()
    expect(es.closed).toBe(true)
  })

  it('on a drop, polls every 2 s until the stream is open again', () => {
    const onPoll = vi.fn()
    const onStatus = vi.fn()
    const s = createEventStream({ url: () => 'u', onEvent: vi.fn(), onPoll, onStatus, EventSourceImpl: FakeES as never })
    const es = FakeES.all[0]
    es.fire('open')
    expect(onStatus).toHaveBeenLastCalledWith('live')
    es.fire('error')
    expect(onStatus).toHaveBeenLastCalledWith('polling')
    vi.advanceTimersByTime(2000)
    expect(onPoll).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(4000)
    expect(onPoll).toHaveBeenCalledTimes(3)
    es.fire('open') // the browser reconnected by itself: one catch-up refresh, then no more polling
    vi.advanceTimersByTime(6000)
    expect(onPoll).toHaveBeenCalledTimes(4)
    s.close()
  })

  it('reopens a stream the browser gave up on, and refreshes once on reconnect', () => {
    const onPoll = vi.fn()
    const s = createEventStream({ url: () => 'u2', onEvent: vi.fn(), onPoll, EventSourceImpl: FakeES as never })
    const es = FakeES.all[0]
    es.fire('open')
    es.readyState = 2
    es.fire('error')
    vi.advanceTimersByTime(2000)
    expect(FakeES.all.length).toBe(2)
    const before = onPoll.mock.calls.length
    FakeES.all[1].fire('open')
    expect(onPoll.mock.calls.length).toBe(before + 1) // catch up on what was missed
    s.close()
    vi.advanceTimersByTime(10_000)
    expect(FakeES.all.length).toBe(2)
  })

  it('falls back to polling when EventSource does not exist', () => {
    const onPoll = vi.fn()
    const s = createEventStream({ url: () => 'u', onEvent: vi.fn(), onPoll, EventSourceImpl: undefined })
    vi.advanceTimersByTime(4000)
    expect(onPoll).toHaveBeenCalledTimes(2)
    s.close()
  })
})
