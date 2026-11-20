// Workaround for a race in xrpl-connect-privy 1.1.0-rc.0 + js-sdk-core 0.79.4, seen on 20 Nov 2026: after the
// embedded-wallet iframe fires `load`, the adapter sends ONE 'privy:iframe:ready' ping, but Privy's iframe attaches
// its message listener a few seconds later (measured: a ping at load gets no answer, the same ping 4 s later does).
// The adapter then fails sign-in with "Privy embedded wallet readiness timed out". This repeats that one ping until
// the iframe answers. Every other message passes through untouched, once.
type Poster = { postMessage(message: unknown, targetOrigin: string, transfer?: unknown): void; reload(): void }
type ClientLike = { setMessagePoster(p: Poster): void; __zeccaReadyPatch?: true }
type SessionLike = { ensureClient(...a: unknown[]): Promise<ClientLike>; __zeccaReadyPatch?: true }

function readyId(message: unknown): string | null {
  if (typeof message !== 'string' || !message.includes('privy:iframe:ready')) return null
  try {
    const m = JSON.parse(message) as { id?: unknown; event?: unknown }
    return m.event === 'privy:iframe:ready' && typeof m.id === 'string' ? m.id : null
  } catch {
    return null
  }
}

function answeredId(data: unknown): string | null {
  let d = data
  if (typeof d === 'string') {
    try {
      d = JSON.parse(d)
    } catch {
      return null
    }
  }
  const m = d as { id?: unknown; event?: unknown } | null
  return m && m.event === 'privy:iframe:ready' && typeof m.id === 'string' ? m.id : null
}

/** Returns true when the adapter's session could be patched (or already was). */
export function patchPrivyIframeReady(
  adapter: unknown,
  opts: { win?: EventTarget; everyMs?: number; maxMs?: number } = {},
): boolean {
  const session = (adapter as { session?: SessionLike } | null)?.session
  if (!session || typeof session.ensureClient !== 'function') return false
  if (session.__zeccaReadyPatch) return true
  const win = opts.win ?? (typeof window !== 'undefined' ? window : undefined)
  const everyMs = opts.everyMs ?? 400
  const maxMs = opts.maxMs ?? 15_000

  const patchClient = (client: ClientLike) => {
    if (client.__zeccaReadyPatch || typeof client.setMessagePoster !== 'function') return
    client.__zeccaReadyPatch = true
    const setPoster = client.setMessagePoster.bind(client)
    client.setMessagePoster = (poster: Poster) =>
      setPoster({
        reload: () => poster.reload(),
        postMessage(message, targetOrigin, transfer) {
          poster.postMessage(message, targetOrigin, transfer)
          const id = readyId(message)
          if (!id || !win) return
          let done = false
          const stop = () => {
            done = true
            clearInterval(timer)
            clearTimeout(limit)
            win.removeEventListener('message', onMessage)
          }
          const onMessage = (e: Event) => {
            if (answeredId((e as MessageEvent).data) === id) stop()
          }
          win.addEventListener('message', onMessage)
          const timer = setInterval(() => {
            if (done) return
            try {
              poster.postMessage(message, targetOrigin)
            } catch {
              stop()
            }
          }, everyMs)
          const limit = setTimeout(stop, maxMs)
        },
      })
  }

  const ensure = session.ensureClient.bind(session)
  session.ensureClient = async (...a: unknown[]) => {
    const client = await ensure(...a)
    patchClient(client)
    return client
  }
  session.__zeccaReadyPatch = true
  return true
}
