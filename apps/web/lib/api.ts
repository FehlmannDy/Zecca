// Typed client over the contracts route table (packages/contracts/src/routes.ts).
// Errors come back as ApiError and are thrown as ZeccaApiError; their message is written to be shown as is.
import { ApiError, routePath, routes, type BodyOf, type ErrorCode, type QueryOf, type ResponseOf, type RouteName } from '@zecca/contracts'
import { z } from 'zod'

export const DEFAULT_API_ORIGIN = 'http://localhost:8800'

export type ApiErrorDetails = NonNullable<ApiError['error']['details']>

export class ZeccaApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly details?: ApiErrorDetails
  constructor(status: number, error: { code: ErrorCode; message: string; details?: ApiErrorDetails }) {
    super(error.message)
    this.name = 'ZeccaApiError'
    this.status = status
    this.code = error.code
    this.details = error.details
  }
}

export const isApiError = (e: unknown): e is ZeccaApiError => e instanceof ZeccaApiError

const OFFLINE = "Can't reach Zecca right now. Check your connection and try again."
const UNKNOWN = 'Something went wrong on our side. Try again in a moment.'

type CallArgs<N extends RouteName> = {
  params?: Record<string, string>
  query?: [QueryOf<N>] extends [never] ? never : QueryOf<N>
  body?: [BodyOf<N>] extends [never] ? never : BodyOf<N>
  signal?: AbortSignal
}

export type ApiClientOptions = {
  origin?: string
  getToken?: () => string | null | undefined
  fetch?: typeof fetch
  /** Called on a 401 so the app can clear the session. */
  onUnauthorized?: () => void
}

export type ApiClient = ReturnType<typeof createApi>

export function createApi(opts: ApiClientOptions = {}) {
  const origin = (opts.origin ?? DEFAULT_API_ORIGIN).replace(/\/$/, '')
  const doFetch = (...a: Parameters<typeof fetch>) => (opts.fetch ?? fetch)(...a)

  function url(name: RouteName, params?: Record<string, string>, query?: Record<string, unknown>) {
    const u = new URL(origin + routePath(name, params))
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
    return u.toString()
  }

  async function call<N extends RouteName>(name: N, args: CallArgs<N> = {} as CallArgs<N>): Promise<ResponseOf<N>> {
    const def = routes[name]
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = opts.getToken?.()
    if (token) headers.authorization = `Bearer ${token}`
    let body: string | undefined
    if (args.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(args.body)
    } else if (def.method === 'POST') {
      headers['content-type'] = 'application/json'
      body = '{}'
    }
    let res: Response
    try {
      res = await doFetch(url(name, args.params, args.query as Record<string, unknown> | undefined), { method: def.method, headers, body, signal: args.signal })
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw e
      throw new ZeccaApiError(0, { code: 'upstream_error', message: OFFLINE })
    }
    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.()
      const parsed = ApiError.safeParse(await res.json().catch(() => null))
      throw new ZeccaApiError(res.status, parsed.success ? parsed.data.error : { code: res.status >= 500 ? 'internal' : 'bad_request', message: UNKNOWN })
    }
    if (typeof def.response === 'string') return (await res.text()) as ResponseOf<N>
    const data: unknown = await res.json()
    const checked = (def.response as z.ZodType).safeParse(data)
    if (!checked.success) {
      // Keep the screen working; the contract tests catch the drift.
      console.warn(`[api] ${name}: response does not match the contract`, checked.error.issues.slice(0, 3))
      return data as ResponseOf<N>
    }
    return checked.data as ResponseOf<N>
  }

  return {
    origin,
    call,
    url,
    /** SSE stream URL; EventSource cannot send headers, so the session goes in the query. */
    eventsUrl(): string {
      const u = new URL(origin + routePath('events'))
      const t = opts.getToken?.()
      if (t) u.searchParams.set('token', t)
      return u.toString()
    },
  }
}
