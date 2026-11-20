// Adding Face ID: link a passkey to the Privy user, then enrol it as the MFA method for transactions.
// Install the MFA handler before enrolling: enrolment goes through invokeWithMfa and may itself ask for a passkey.
import type { PasskeyPrivyClient, PrivyUserLike } from './privy-client'
import { creationOptionsFromPrivy, registrationJsonFromCredential } from './webauthn'

export type PasskeyStatus = { credentialIds: string[]; enrolled: boolean }

export function passkeyStatus(user: PrivyUserLike): PasskeyStatus {
  const credentialIds = user.linked_accounts.flatMap((a) => (a.type === 'passkey' && a.credential_id ? [a.credential_id] : []))
  return { credentialIds, enrolled: user.mfa_methods.some((m) => m.type === 'passkey') }
}

export async function readPasskeyStatus(client: PasskeyPrivyClient): Promise<PasskeyStatus> {
  return passkeyStatus((await client.user.get()).user)
}

/** Registration options from Privy -> the phone's passkey prompt -> linked to the signed-in Privy user. */
export async function linkPasskey(
  client: PasskeyPrivyClient,
  opts: { credentials?: Pick<CredentialsContainer, 'create'>; signal?: AbortSignal } = {},
): Promise<{ credentialId: string; user: PrivyUserLike }> {
  const credentials = opts.credentials ?? navigator.credentials
  const init = await client.auth.passkey.generateRegistrationOptions()
  let credential: Credential | null
  try {
    credential = await credentials.create({ publicKey: creationOptionsFromPrivy(init), ...(opts.signal ? { signal: opts.signal } : {}) })
  } catch (e) {
    const name = (e as { name?: string })?.name
    if (name === 'NotAllowedError' || name === 'AbortError') throw new Error('Face ID was cancelled.')
    if (name === 'InvalidStateError') throw new Error('This phone already has a passkey for Zecca.')
    throw e
  }
  const json = registrationJsonFromCredential(credential)
  const rp = (init as { relying_party?: unknown })?.relying_party
  const { user } = await client.auth.passkey.linkWithPasskey(json, typeof rp === 'string' ? rp : undefined)
  return { credentialId: json.id, user }
}

/** Enrol the linked passkeys (all of them unless given) as the MFA method. Returns the status Privy now reports. */
export async function enrollPasskeyMfa(client: PasskeyPrivyClient, opts: { credentialIds?: string[] } = {}): Promise<PasskeyStatus> {
  const credentialIds = opts.credentialIds ?? (await readPasskeyStatus(client)).credentialIds
  if (credentialIds.length === 0) throw new Error('Add Face ID first.')
  await client.mfa.submitEnrollMfa({ method: 'passkey', credentialIds })
  return readPasskeyStatus(client)
}

/**
 * One verification now (privy:mfa:verify always asks). Privy then remembers it for the dashboard's
 * "MFA verification duration", so a signature right after does not prompt again. Needs the MFA handler installed.
 */
export async function verifyPasskeyNow(client: PasskeyPrivyClient): Promise<void> {
  await client.mfa.verifyMfa()
}
