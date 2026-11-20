'use client'
// The public stream of one payment request (GET /v1/payment-requests/:id/events): its first message is the current
// state, then every change. While it is down, `onPoll` runs every 2 s (SPEC §7).
import { useEffect, useRef, useState } from 'react'
import type { PaymentRequest } from '@zecca/contracts'
import { useApi, whenMockReady } from '@/lib/app'
import { createEventStream, type StreamStatus } from '@/lib/events'

export function useRequestStream(id: string | null | undefined, onRequest: (r: PaymentRequest) => void, onPoll: () => void): StreamStatus {
  const api = useApi()
  const [status, setStatus] = useState<StreamStatus>('connecting')
  const handlers = useRef({ onRequest, onPoll })
  handlers.current = { onRequest, onPoll }
  useEffect(() => {
    if (!id) return
    let live = true
    let stream: { close(): void } | null = null
    whenMockReady().then(() => {
      if (!live) return
      stream = createEventStream({
        url: () => api.url('paymentRequestEvents', { id }),
        onEvent: (e) => {
          if (e.type === 'payment_request.updated' && e.data.id === id) handlers.current.onRequest(e.data)
        },
        onPoll: () => handlers.current.onPoll(),
        onStatus: setStatus,
      })
    })
    return () => {
      live = false
      stream?.close()
    }
  }, [api, id])
  return status
}

/** Calls `fn` every `ms` while `on` (a safety net next to the stream while a payment is landing). */
export function useInterval(fn: () => void, ms: number, on: boolean) {
  const f = useRef(fn)
  f.current = fn
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => f.current(), ms)
    return () => clearInterval(t)
  }, [ms, on])
}
