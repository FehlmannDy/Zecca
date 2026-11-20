'use client'
import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react'
import type { ZeccaEvent } from '@zecca/contracts'
import { isApiError } from './api'
import { useApi, whenMockReady } from './app'
import { createEventStream, type StreamStatus } from './events'
import { useSession } from './session'

/** Load something once (and on reload): data, error message, loading, plus setData for live patches. */
export function useResource<T>(load: () => Promise<T>, deps: DependencyList, enabled = true) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [n, setN] = useState(0)
  const loader = useRef(load)
  loader.current = load
  useEffect(() => {
    if (!enabled) return
    let live = true
    setLoading(true)
    setError(null)
    loader
      .current()
      .then((d) => live && setData(d))
      .catch((e) => live && setError(isApiError(e) || e instanceof Error ? e.message : 'Something went wrong. Try again.'))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n, enabled])
  /** Refetch without clearing what is on screen. */
  const refresh = useCallback(() => {
    loader
      .current()
      .then((d) => setData(d))
      .catch(() => {})
  }, [])
  return { data, error, loading: loading && !data, reload: () => setN((x) => x + 1), refresh, setData }
}

/** Subscribe to the session's event stream; on a drop, `onPoll` runs every 2 s until it reconnects. */
export function useLiveEvents(onEvent: (e: ZeccaEvent) => void, onPoll: () => void): StreamStatus {
  const api = useApi()
  const session = useSession()
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const handlers = useRef({ onEvent, onPoll })
  handlers.current = { onEvent, onPoll }
  const token = session?.token
  useEffect(() => {
    if (!token) return
    let live = true
    let stream: { close(): void } | null = null
    whenMockReady().then(() => {
      if (!live) return
      stream = createEventStream({
        url: () => api.eventsUrl(),
        onEvent: (e) => handlers.current.onEvent(e),
        onPoll: () => handlers.current.onPoll(),
        onStatus: setStatus,
      })
    })
    return () => {
      live = false
      stream?.close()
    }
  }, [api, token])
  return status
}
