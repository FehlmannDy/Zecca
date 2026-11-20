// One card context per API instance: the sub-ledger, the Lithic client (sandbox, from LITHIC_API_KEY), the simulate gate,
// the ASA secret (memory + the connector's table, never logged) and the small in-flight locks.
import { timingSafeEqual } from 'node:crypto'
import type { Core } from '../../core'
import { Err } from '../../errors'
import { createGate, createLithicHttp, type LithicApi } from './lithic-api'
import { cardStore, toAuthorization, type CardStore, type HoldRow } from './store'

export type CardOptions = {
  /** Lithic client; default: the sandbox HTTP client when LITHIC_API_KEY is set, else none (routes answer 502). */
  lithic?: LithicApi | null
  /** Minimum gap between two simulate calls (sandbox: 1 per second). Default 1100 ms. */
  simulateGapMs?: number
  /** Poll Lithic for clearing, voids and returns every n ms. 0 = off. Default 15 000. */
  pollMs?: number
}

export type CardCtx = {
  store: CardStore
  lithic: LithicApi | null
  gate: ReturnType<typeof createGate>
  pollMs: number
  secret?: string
  secretP?: Promise<string>
  creating: Map<string, Promise<unknown>>
  charging: Set<string>
  syncing: boolean
  timer?: NodeJS.Timeout
}

const contexts = new WeakMap<Core, CardCtx>()

/** The context of this API instance, created on first use with the options of that first call. */
export function cardCtx(core: Core, opts: CardOptions = {}): CardCtx {
  let ctx = contexts.get(core)
  if (ctx) return ctx
  let lithic: LithicApi | null = null
  if (opts.lithic !== undefined) lithic = opts.lithic
  else if (core.env.LITHIC_API_KEY) {
    try {
      lithic = createLithicHttp({ apiKey: core.env.LITHIC_API_KEY, baseUrl: core.env.LITHIC_BASE_URL })
    } catch (e) {
      core.log.error(`[card] Lithic is not usable: ${(e as Error).message}`)
    }
  }
  ctx = {
    store: cardStore(core),
    lithic,
    gate: createGate(opts.simulateGapMs ?? 1100),
    pollMs: opts.pollMs ?? 15_000,
    creating: new Map(),
    charging: new Set(),
    syncing: false,
  }
  contexts.set(core, ctx)
  return ctx
}

export const UNAVAILABLE = 'Cards are not available right now. Try again later.'
const NO_ANSWER = "The card service didn't answer. Try again in a moment."

export function needLithic(ctx: CardCtx): LithicApi {
  if (!ctx.lithic) throw Err.upstream(UNAVAILABLE)
  return ctx.lithic
}

/** A Lithic call from a request: its failure is logged in full and shown in plain words. */
export async function viaLithic<T>(core: Core, what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (e) {
    core.log.error(`[card] ${what} failed: ${(e as Error).message}`)
    throw Err.upstream(NO_ANSWER)
  }
}

/** The ASA HMAC secret: LITHIC_ASA_SECRET (local tests), else the stored one, else fetched once from Lithic and kept. */
export async function asaSecret(core: Core, ctx: CardCtx): Promise<string | undefined> {
  if (core.env.LITHIC_ASA_SECRET) return core.env.LITHIC_ASA_SECRET
  if (ctx.secret) return ctx.secret
  const stored = ctx.store.getKv('asaSecret')
  if (stored) return (ctx.secret = stored)
  if (!ctx.lithic) return undefined
  const lithic = ctx.lithic
  ctx.secretP ??= lithic
    .authStreamSecret()
    .then((s) => {
      ctx.store.setKv('asaSecret', s)
      ctx.secret = s
      return s
    })
    .finally(() => {
      ctx.secretP = undefined
    })
  return ctx.secretP
}

/** Where approved card spend settles on the ledger (SPEC §2.2). */
export function settlementAddress(core: Core): string | undefined {
  if (core.keystore.hasWallet('cardSettlement')) return core.keystore.getWallet('cardSettlement').address
  return core.env.CARD_SETTLEMENT_ADDRESS || undefined
}

/** "SETTE ARCHI" -> "Sette Archi": card descriptors are upper case; the app shows names. */
export function displayMerchant(descriptor: string): string {
  const s = descriptor.trim().replace(/\s+/g, ' ')
  if (!s) return 'Card payment'
  return s.toLowerCase().replace(/(^|[\s\-/&.'])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase())
}

export const sameSecret = (a: string | undefined, b: string | undefined): boolean => {
  const x = Buffer.from(a ?? '')
  const y = Buffer.from(b ?? '')
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}

/** card.authorization to the cardholder (SPEC §7). The app upserts by id. */
export function emitAuthorization(core: Core, h: HoldRow | undefined): void {
  if (!h) return
  core.bus.toUser(h.userId, { type: 'card.authorization', data: toAuthorization(h), at: core.iso() })
}
