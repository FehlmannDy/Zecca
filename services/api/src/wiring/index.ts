// Picks the wiring for LEDGER_MODE. The devnet modules load only when asked for.
import type { Env } from '../config'
import type { Wiring } from './types'

export type { Wiring } from './types'

export async function wiringFor(env: Env, log: (m: string) => void): Promise<Wiring> {
  if (env.LEDGER_MODE === 'devnet') return (await import('./devnet')).devnetWiring(env, log)
  return (await import('./mock')).mockWiring(env, log)
}
