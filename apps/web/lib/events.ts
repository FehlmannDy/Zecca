// Live updates over SSE (GET /v1/events?token=...). Each message is one JSON ZeccaEvent; the SSE event name is its type.
// When the stream drops, poll every 2 s until it is open again (SPEC §7).
import { EVENT_TYPES, ZeccaEvent } from '@zecca/contracts'

export type StreamStatus = 'connecting' | 'live' | 'polling' | 'closed'

type ESLike = {
  readyState: number
  addEventListener(type: string, fn: (e: { data: string }) => void): void
  close(): void
}
type ESCtor = new (url: string) => ESLike

export function createEventStream(opts: {
  url: () => string
  onEvent: (e: ZeccaEvent) => void
  /** Refresh what the stream would have pushed (balance, activity, a request). */
  onPoll: () => void
  onStatus?: (s: StreamStatus) => void
  pollMs?: number
  EventSourceImpl?: ESCtor
}) {
  const pollMs = opts.pollMs ?? 2000
  const ES: ESCtor | undefined = 'EventSourceImpl' in opts ? opts.EventSourceImpl : (globalThis as { EventSource?: ESCtor }).EventSource
  let es: ESLike | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let closed = false
  let dropped = false
  const status = (s: StreamStatus) => opts.onStatus?.(s)

  const startPolling = () => {
    if (poll || closed) return
    status('polling')
    poll = setInterval(() => {
      opts.onPoll()
      // The browser stops retrying after some errors (readyState CLOSED): open a new stream ourselves.
      if (ES && (!es || es.readyState === 2)) connect()
    }, pollMs)
  }
  const stopPolling = () => {
    if (poll) clearInterval(poll)
    poll = null
  }

  function onMessage(e: { data: string }) {
    let raw: unknown
    try {
      raw = JSON.parse(e.data)
    } catch {
      return
    }
    const parsed = ZeccaEvent.safeParse(raw)
    if (parsed.success && parsed.data.type !== 'ping') opts.onEvent(parsed.data)
  }

  function connect() {
    if (closed || !ES) return
    es?.close()
    const current = new ES(opts.url())
    es = current
    status('connecting')
    current.addEventListener('open', () => {
      if (es !== current) return
      stopPolling()
      status('live')
      if (dropped) opts.onPoll() // catch up on anything missed while down
      dropped = false
    })
    current.addEventListener('error', () => {
      if (es !== current || closed) return
      dropped = true
      startPolling()
    })
    for (const t of EVENT_TYPES) current.addEventListener(t, onMessage)
    current.addEventListener('message', onMessage)
  }

  if (ES) connect()
  else startPolling()

  return {
    close() {
      closed = true
      stopPolling()
      es?.close()
      status('closed')
    },
  }
}
