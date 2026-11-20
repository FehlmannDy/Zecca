// One MFA handler per Privy client, installed next to the xrpl-connect adapter after sign-in. Installing it is safe
// for everyone in SIGNER_MODE=privy: it only acts when Privy asks for a passkey, which only happens once a user has
// enrolled one; without it such a user's signature would wait for an answer that never comes.
import { getPrivyClient, type PasskeyPrivyClient } from './privy-client'
import { installMfaHandler, type MfaHandler, type MfaHandlerOptions, type MfaOutcome } from './mfa-handler'

export type PasskeyEvent = { type: 'prompt' } | { type: 'done'; outcome: MfaOutcome } | { type: 'log'; event: string; detail?: Record<string, unknown> }
export type InstalledPasskeyMfa = MfaHandler & { client: PasskeyPrivyClient; subscribe(fn: (e: PasskeyEvent) => void): () => void }

const installed = new WeakMap<object, InstalledPasskeyMfa>()

/** Returns the handler for this adapter's client, or null before the user has signed in on this page. */
export function installPasskeyMfa(source: unknown, opts: Omit<MfaHandlerOptions, 'onPrompt' | 'onDone' | 'log'> = {}): InstalledPasskeyMfa | null {
  let client: PasskeyPrivyClient
  try {
    client = getPrivyClient(source)
  } catch {
    return null
  }
  const existing = installed.get(client)
  if (existing) return existing
  const listeners = new Set<(e: PasskeyEvent) => void>()
  const send = (e: PasskeyEvent) => listeners.forEach((fn) => fn(e))
  const handler = installMfaHandler(client, {
    ...opts,
    onPrompt: () => send({ type: 'prompt' }),
    onDone: (outcome) => send({ type: 'done', outcome }),
    log: (event, detail) => send({ type: 'log', event, detail }),
  })
  const out: InstalledPasskeyMfa = {
    ...handler,
    client,
    subscribe(fn) {
      listeners.add(fn)
      return () => void listeners.delete(fn)
    },
  }
  installed.set(client, out)
  return out
}
