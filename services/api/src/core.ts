// The dependencies every module uses, built once by createApp.
import { randomBytes } from 'node:crypto'
import type { KeyStore, Ledger, PoolWorker } from '@zecca/contracts'
import type { Db } from './db'
import type { EventBus } from './bus'
import type { Env, Settings } from './config'
import type { PrivyVerifier } from './auth/privy'
import type { SubmitHandler } from './prepared/submit'

export type Logger = { info(msg: string): void; warn(msg: string): void; error(msg: string): void }

export type Core = {
  env: Env
  settings: Settings
  db: Db
  ledger: Ledger
  keystore: KeyStore
  pool: PoolWorker
  privy?: PrivyVerifier
  bus: EventBus
  log: Logger
  /** Milliseconds since the epoch (injectable clock). */
  now(): number
  iso(ms?: number): string
  /** New opaque id with a readable prefix, e.g. id('int') -> 'int_01H…'. */
  id(prefix: string): string
  /** What happens around POST /v1/tx/submit, per PreparedTx kind. */
  submitHandlers: Map<string, SubmitHandler>
  /**
   * What happens when the pool confirms a deposit, per intent kind (phase-2 connectors: card_load, market_buy, earn_deposit).
   * Called once per intent, after submitted -> received. Kinds without a handler get the p2p/merchant effects (credit + payout).
   */
  receivedHandlers: Map<string, (core: Core, intentId: string) => void | Promise<void>>
  /** Background work started by request handlers (payouts, merges); tests await it. */
  track(p: Promise<unknown>, what: string): void
  idle(): Promise<void>
  /** Per-user prepare rate limit (sign-up, send, pay). Throws 429 rate_limited. */
  rateLimit(key: string): void
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
export function randomId(prefix: string): string {
  const b = randomBytes(16)
  let s = ''
  for (const x of b) s += ALPHABET[x & 31]
  return `${prefix}_${s}`
}

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} }
