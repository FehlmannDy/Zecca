// "To" field lookup (UI.md §5.4): debounced GET /v1/directory/resolve as the person types. Only the latest text
// counts: an older answer that arrives late is ignored and its request is aborted.
import type { PublicProfile } from '@zecca/contracts'

export type ResolveAnswer = { kind: 'zecca'; profile: PublicProfile } | { kind: 'external'; address: string } | { kind: 'unknown' }

export type ResolverState =
  | { kind: 'idle' }
  | { kind: 'waiting'; q: string }
  | { kind: 'found'; q: string; profile: PublicProfile }
  | { kind: 'self'; q: string }
  | { kind: 'external'; q: string }
  | { kind: 'unknown'; q: string }
  | { kind: 'error'; q: string; message: string }

/** The text to look up, or null while it is too short (handles are 3+ characters) or too long for the API. */
export function lookupQuery(raw: string): string | null {
  const q = raw.trim()
  if (q.replace(/^@/, '').length < 3 || q.length > 120) return null
  return q
}

export function createResolver(opts: {
  resolve: (q: string, signal: AbortSignal) => Promise<ResolveAnswer>
  onChange: (s: ResolverState) => void
  /** The signed-in user's id: finding them gives 'self'. */
  selfId?: string
  delayMs?: number
}) {
  const delay = opts.delayMs ?? 300
  let state: ResolverState = { kind: 'idle' }
  let timer: ReturnType<typeof setTimeout> | null = null
  let inflight: AbortController | null = null
  let current: string | null | undefined = undefined
  let disposed = false

  const set = (s: ResolverState) => {
    state = s
    opts.onChange(s)
  }
  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
    inflight?.abort()
    inflight = null
  }

  async function run(q: string) {
    const ctrl = new AbortController()
    inflight = ctrl
    try {
      const a = await opts.resolve(q, ctrl.signal)
      if (ctrl.signal.aborted || disposed || current !== q) return
      if (a.kind === 'zecca') set(a.profile.id === opts.selfId ? { kind: 'self', q } : { kind: 'found', q, profile: a.profile })
      else set({ kind: a.kind, q })
    } catch (e) {
      if (ctrl.signal.aborted || disposed || current !== q) return
      set({ kind: 'error', q, message: e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.' })
    } finally {
      if (inflight === ctrl) inflight = null
    }
  }

  return {
    input(raw: string) {
      if (disposed) return
      const q = lookupQuery(raw)
      if (q === current) return
      cancel()
      current = q
      if (q === null) return set({ kind: 'idle' })
      set({ kind: 'waiting', q })
      timer = setTimeout(() => {
        timer = null
        void run(q)
      }, delay)
    },
    state: () => state,
    dispose() {
      disposed = true
      cancel()
    },
  }
}
