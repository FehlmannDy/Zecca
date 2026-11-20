// The part of Privy's js-sdk-core client (0.79.4) this folder uses, and how to reach it next to the xrpl-connect adapter.
// The adapter (pinned at 1.1.0-rc.0) keeps its client private: adapter.session.client, created on the first connect.
import type { PrivyPasskeyAssertion, RegistrationJson } from './webauthn'

export type PrivyLinkedAccount = { type: string; credential_id?: string; enrolled_in_mfa?: boolean }
export type PrivyUserLike = { id: string; linked_accounts: PrivyLinkedAccount[]; mfa_methods: { type: string }[] }

export type MfaSubmitArgs = { mfaMethod: 'passkey'; mfaCode: PrivyPasskeyAssertion; relyingParty: string }
type Deferred<T, E = unknown> = { current: { resolve: (v: T) => void; reject: (e: E) => void } | null }

export interface PasskeyPrivyClient {
  auth: {
    passkey: {
      generateRegistrationOptions(relyingParty?: string): Promise<unknown>
      linkWithPasskey(input: RegistrationJson, relyingParty?: string): Promise<{ user: PrivyUserLike }>
    }
  }
  mfa: {
    passkey: { generateAuthenticationOptions(args: { relying_party?: string }): Promise<unknown> }
    submitEnrollMfa(args: { method: 'passkey'; credentialIds: string[]; removeForLogin?: boolean }): Promise<unknown>
    /** privy:mfa:verify, always asks for MFA: one verification now covers the next signatures for the dashboard's duration. */
    verifyMfa(): Promise<unknown>
  }
  /**
   * js-sdk-core's MFA hand-off: on missing_or_invalid_mfa, invokeWithMfa emits 'mfaRequired', then waits (up to 300 s)
   * for rootPromise.current.resolve({ mfaMethod, mfaCode, relyingParty }); submitPromise.current settles per attempt.
   */
  mfaPromises: {
    on(event: 'mfaRequired', fn: () => void): unknown
    off(event: 'mfaRequired', fn: () => void): unknown
    rootPromise: Deferred<MfaSubmitArgs, Error>
    submitPromise: Deferred<undefined>
  }
  user: { get(): Promise<{ user: PrivyUserLike }> }
}

/** The adapter's js-sdk-core client. Throws an English message until the user has signed in once on this page. */
export function getPrivyClient(source: unknown): PasskeyPrivyClient {
  const adapter = (source as { adapter?: unknown })?.adapter ?? source
  const client = (adapter as { session?: { client?: unknown } } | null)?.session?.client as Partial<PasskeyPrivyClient> | undefined
  if (!client || !client.mfaPromises || !client.mfa || !client.auth?.passkey) throw new Error('Sign in first to add Face ID.')
  return client as PasskeyPrivyClient
}
