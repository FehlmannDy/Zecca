// Server-Sent Events (SPEC §7): GET /v1/events per session, and the public per-request stream. Keep-alive ping every 20 s.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { ZeccaEvent } from '@zecca/contracts'
import type { Core } from './core'
import type { BusListener } from './bus'
import { mount } from './http'
import { getBalance } from './books'

export const PING_MS = 20_000

/** Streams bus events to one client until it disconnects. `initial` events go first (the current state). */
export function sse(c: Context, core: Core, subscribe: (l: BusListener) => () => void, initial: ZeccaEvent[] = []): Response {
  return streamSSE(c, async (stream) => {
    let chain = Promise.resolve()
    const send = (e: ZeccaEvent) => {
      chain = chain.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {})
    }
    for (const e of initial) send(e)
    const unsub = subscribe(send)
    const ping = setInterval(() => send({ type: 'ping', data: {}, at: core.iso() }), PING_MS)
    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        unsub()
        clearInterval(ping)
        resolve()
      })
    })
  })
}

export function mountEvents(app: Hono, core: Core): void {
  mount(app, core, 'events', ({ c, user }) =>
    sse(c, core, (l) => core.bus.subscribeUser(user!.id, l), [{ type: 'balance.updated', data: getBalance(core, user!.id), at: core.iso() }]),
  )
}
