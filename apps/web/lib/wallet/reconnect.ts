// One reconnect at a time per wallet manager: xrpl-connect refuses a second one while the first runs.
type Reconnectable<A> = { reconnect(): Promise<A> }

const inflight = new WeakMap<object, Promise<unknown>>()

export function reconnectOnce<A>(manager: Reconnectable<A>): Promise<A> {
  const running = inflight.get(manager) as Promise<A> | undefined
  if (running) return running
  const p = manager.reconnect().finally(() => inflight.delete(manager))
  inflight.set(manager, p)
  return p
}
