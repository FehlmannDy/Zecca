// Mounts a route from the contracts' route table: auth, feature flag, body/query validation, response validation.
import type { Context, Hono } from 'hono'
import type { z } from 'zod'
import { routes, type RouteDef, type RouteName } from '@zecca/contracts'
import { ApiErr, Err } from './errors'
import type { Core } from './core'
import { lookupSession, type Session } from './auth/sessions'
import type { UserRow } from './users'

type Def<N extends RouteName> = (typeof routes)[N]
type Out<S> = S extends z.ZodType ? z.output<S> : undefined
export type BodyT<N extends RouteName> = Def<N> extends { body: infer B } ? Out<B> : undefined
export type QueryT<N extends RouteName> = Def<N> extends { query: infer Q } ? Out<Q> : undefined
export type ResT<N extends RouteName> = Def<N>['response'] extends z.ZodType ? z.input<Def<N>['response']> : never

export type Req<N extends RouteName> = {
  c: Context
  body: BodyT<N>
  query: QueryT<N>
  params: Record<string, string>
  /** Present on authenticated routes; optional on public ones (when a valid Bearer is sent). */
  session?: Session
  /** Present when the route requires an active user. */
  user?: UserRow
}

/** Routes a session may call before the user exists (sign-up). */
const PRE_SIGNUP: ReadonlySet<RouteName> = new Set(['onboardingPrepare', 'txSubmit'])

function bearer(c: Context, allowQuery: boolean): string | undefined {
  const h = c.req.header('authorization')
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim()
  if (allowQuery) return c.req.query('token') ?? undefined
  return undefined
}

/** English message from a zod error: the first issue, with its field. */
export function zodMessage(err: z.ZodError): string {
  const i = err.issues[0]
  if (!i) return 'Some details are missing or not valid.'
  const field = i.path.join('.')
  // Custom messages in the contracts are already English sentences.
  if (i.code === 'invalid_format' || i.code === 'custom') return field && !/[.!?]$/.test(i.message) ? `${field}: ${i.message}.` : i.message
  if (!field) return 'Some details are missing or not valid.'
  return i.code === 'invalid_type' && /received undefined/.test(i.message) ? `${field} is missing.` : `${field} is not valid.`
}

export function mount<N extends RouteName>(
  app: Hono,
  core: Core,
  name: N,
  handler: (r: Req<N>) => Promise<ResT<N> | Response> | ResT<N> | Response,
): void {
  const def = routes[name] as RouteDef
  const isStream = def.response === 'sse'
  app.on(def.method, def.path, async (c) => {
    if (def.feature && !core.settings.features[def.feature as keyof typeof core.settings.features]) throw Err.featureOff()
    if ((def.auth === 'dev' || def.auth === 'demo') && !core.settings.demoMode) throw Err.notFound()

    let session: Session | undefined
    let user: UserRow | undefined
    const token = bearer(c, isStream)
    if (def.auth === 'user' || def.auth === 'merchant' || def.auth === 'dev') {
      if (!token) throw Err.unauthorized()
      session = lookupSession(core, token)
      if (!session) throw Err.unauthorized()
      if (!PRE_SIGNUP.has(name)) {
        if (!session.user || session.user.status !== 'active') throw Err.notSignedUp()
        user = session.user
        if (def.auth === 'merchant' && !user.roles.includes('merchant')) throw Err.forbidden('This is for business accounts.')
      } else if (session.user?.status === 'active') {
        user = session.user
      }
    } else if (token) {
      session = lookupSession(core, token)
      if (session?.user?.status === 'active') user = session.user
    }

    let body: unknown = undefined
    if (def.body) {
      let raw: unknown
      try {
        raw = await c.req.json()
      } catch {
        throw Err.badRequest('The request body must be JSON.')
      }
      const p = def.body.safeParse(raw)
      if (!p.success) throw Err.badRequest(zodMessage(p.error))
      body = p.data
    }
    let query: unknown = undefined
    if (def.query) {
      const p = def.query.safeParse(c.req.query())
      if (!p.success) throw Err.badRequest(zodMessage(p.error))
      query = p.data
    }

    const out = await handler({ c, body, query, params: c.req.param() as Record<string, string>, session, user } as Req<N>)
    if (out instanceof Response) return out
    if (typeof def.response !== 'string' && core.settings.validateResponses) {
      const p = def.response.safeParse(out)
      if (!p.success) {
        core.log.error(`[api] response of ${name} breaks its contract: ${JSON.stringify(p.error.issues.slice(0, 3))}`)
        throw Err.internal()
      }
    }
    return c.json(out as object, 200)
  })
}

export function errorResponse(c: Context, err: unknown, core: Core): Response {
  if (err instanceof ApiErr) return c.json(err.body(), err.status)
  core.log.error(`[api] ${c.req.method} ${c.req.path} failed: ${(err as Error)?.stack ?? String(err)}`)
  return c.json(Err.internal().body(), 500)
}
