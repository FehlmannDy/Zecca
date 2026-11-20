// In-process event bus. Per-user streams (GET /v1/events) and per-request public streams (GET /v1/payment-requests/:id/events).
import type { ZeccaEvent } from '@zecca/contracts'

export type BusListener = (e: ZeccaEvent) => void

export type EventBus = {
  toUser(userId: string, e: ZeccaEvent): void
  toRequest(paymentRequestId: string, e: ZeccaEvent): void
  subscribeUser(userId: string, l: BusListener): () => void
  subscribeRequest(paymentRequestId: string, l: BusListener): () => void
  /** Every event sent, in order (tests and debugging). */
  history(): Array<{ to: string; event: ZeccaEvent }>
  /** Open subscriptions for one user / request (diagnostics). */
  listenerCount(kind: 'user' | 'request', id: string): number
}

export function createEventBus(opts: { keepHistory?: number; log?: (msg: string) => void } = {}): EventBus {
  const users = new Map<string, Set<BusListener>>()
  const requests = new Map<string, Set<BusListener>>()
  const hist: Array<{ to: string; event: ZeccaEvent }> = []
  const max = opts.keepHistory ?? 500

  const add = (m: Map<string, Set<BusListener>>, k: string, l: BusListener) => {
    let s = m.get(k)
    if (!s) m.set(k, (s = new Set()))
    s.add(l)
    return () => {
      s.delete(l)
      if (s.size === 0) m.delete(k)
    }
  }
  const send = (m: Map<string, Set<BusListener>>, k: string, to: string, e: ZeccaEvent) => {
    hist.push({ to, event: e })
    if (hist.length > max) hist.shift()
    for (const l of m.get(k) ?? []) {
      try {
        l(e)
      } catch (err) {
        opts.log?.(`[bus] listener failed: ${(err as Error).message}`)
      }
    }
  }
  return {
    toUser: (userId, e) => send(users, userId, `user:${userId}`, e),
    toRequest: (id, e) => send(requests, id, `request:${id}`, e),
    subscribeUser: (userId, l) => add(users, userId, l),
    subscribeRequest: (id, l) => add(requests, id, l),
    history: () => hist.slice(),
    listenerCount: (kind, id) => (kind === 'user' ? users : requests).get(id)?.size ?? 0,
  }
}
