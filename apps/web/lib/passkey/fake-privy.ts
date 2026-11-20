// Test double of the js-sdk-core client parts in privy-client.ts. Not used by the app.
// fakeInvokeWithMfa is a line-by-line port of js-sdk-core 0.79.4's MFA loop (the minified `Kn` behind invokeWithMfa),
// so the handler is tested against the same ordering: 'mfaRequired' is emitted BEFORE rootPromise.current is replaced,
// the old deferred is never cleared, a failed attempt rejects submitPromise and waits for a new rootPromise.
import type { MfaSubmitArgs, PasskeyPrivyClient, PrivyUserLike } from './privy-client'
import type { BrowserCredential } from './webauthn'

export class FakeIframeError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message)
  }
}

type Root = PasskeyPrivyClient['mfaPromises']['rootPromise']
type Submit = PasskeyPrivyClient['mfaPromises']['submitPromise']

export async function fakeInvokeWithMfa<T>(
  op: (mfa?: MfaSubmitArgs) => Promise<T>,
  root: Root,
  submit: Submit,
  emit: () => void,
  alwaysRequired = false,
  attempts = 4,
  waitMs = 5000,
): Promise<T> {
  let needsMfa = alwaysRequired
  const attempt = async (n: number): Promise<T> => {
    if (needsMfa) {
      if (n === +!alwaysRequired) emit()
      else submit.current?.reject(new FakeIframeError('missing_or_invalid_mfa', 'MFA verification failed, retry.') as never)
      const args = await new Promise<MfaSubmitArgs>((resolve, reject) => {
        root.current = { resolve, reject }
        setTimeout(() => {
          const e = new FakeIframeError('mfa_timeout', 'Timed out waiting for MFA code')
          submit.current?.reject(e as never)
          reject(e)
        }, waitMs)
      })
      return await op(args)
    }
    return await op()
  }
  let result: T | null = null
  for (let n = 0; n < attempts; n += 1) {
    try {
      result = await attempt(n)
      submit.current?.resolve(undefined)
      break
    } catch (e) {
      if ((e as { type?: string }).type === 'missing_or_invalid_mfa') needsMfa = true
      else {
        submit.current?.resolve(undefined)
        throw e
      }
    }
  }
  if (result === null) {
    const e = new FakeIframeError('mfa_verification_max_attempts_reached', 'Max MFA verification attempts reached')
    submit.current?.reject(e as never)
    throw e
  }
  return result
}

const buf = (...b: number[]) => new Uint8Array(b).buffer

/** A fake authenticator: create() makes credential 'cred-1', get() signs with signature bytes [7, 8]. */
export function fakeCredentials(opts: { get?: (o: CredentialRequestOptions) => Promise<unknown> } = {}) {
  const calls = { create: [] as CredentialCreationOptions[], get: [] as CredentialRequestOptions[] }
  const assertion: BrowserCredential = {
    id: 'cred-1',
    rawId: buf(1, 2),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response: { clientDataJSON: buf(3), authenticatorData: buf(6), signature: buf(7, 8), userHandle: buf(9) },
    getClientExtensionResults: () => ({}),
  }
  const registration: BrowserCredential = {
    id: 'cred-1',
    rawId: buf(1, 2),
    type: 'public-key',
    response: { clientDataJSON: buf(3), attestationObject: buf(4, 5), getTransports: () => ['internal'] },
    getClientExtensionResults: () => ({}),
  }
  return {
    calls,
    create: async (o: CredentialCreationOptions) => {
      calls.create.push(o)
      return registration as unknown as Credential
    },
    get: async (o: CredentialRequestOptions) => {
      calls.get.push(o)
      return (opts.get ? await opts.get(o) : assertion) as Credential
    },
  }
}

/** A Privy client whose sign() needs a passkey MFA once enrolled, verified for `verifiedForMs` afterwards. */
export function fakePrivy(opts: { enrolled?: boolean; verifiedForMs?: number; acceptSignature?: string } = {}) {
  const listeners = new Set<() => void>()
  const state = {
    user: { id: 'did:privy:1', linked_accounts: [{ type: 'email' }], mfa_methods: [] } as PrivyUserLike,
    verifiedUntil: 0,
    calls: [] as string[],
  }
  if (opts.enrolled) {
    state.user.linked_accounts.push({ type: 'passkey', credential_id: 'cred-1', enrolled_in_mfa: true })
    state.user.mfa_methods.push({ type: 'passkey' })
  }
  const accept = opts.acceptSignature ?? 'Bwg'
  const mfaPromises: PasskeyPrivyClient['mfaPromises'] = {
    on: (_e, fn) => listeners.add(fn),
    off: (_e, fn) => listeners.delete(fn),
    rootPromise: { current: null },
    submitPromise: { current: null },
  }
  const emit = () => listeners.forEach((fn) => fn())
  const verified = () => Date.now() < state.verifiedUntil
  const check = (mfa: MfaSubmitArgs) => {
    if (mfa.mfaMethod !== 'passkey' || mfa.mfaCode.response.signature !== accept) throw new FakeIframeError('missing_or_invalid_mfa', 'invalid')
    state.verifiedUntil = Date.now() + (opts.verifiedForMs ?? 0)
  }
  const mfaOp = (always: boolean) => async (mfa?: MfaSubmitArgs) => {
    if (mfa) check(mfa)
    else if ((always || state.user.mfa_methods.length > 0) && !verified()) throw new FakeIframeError('missing_or_invalid_mfa', 'MFA required')
  }
  const client: PasskeyPrivyClient = {
    auth: {
      passkey: {
        generateRegistrationOptions: async () => {
          state.calls.push('generateRegistrationOptions')
          return {
            relying_party: 'https://zecca.test',
            options: { challenge: 'AQID', rp: { name: 'Zecca', id: 'zecca.test' }, user: { id: 'BAUG', name: 'ana', display_name: 'ana' }, pub_key_cred_params: [{ type: 'public-key', alg: -7 }] },
          }
        },
        linkWithPasskey: async (input, rp) => {
          state.calls.push(`linkWithPasskey:${input.id}:${rp}`)
          state.user.linked_accounts.push({ type: 'passkey', credential_id: input.id, enrolled_in_mfa: false })
          return { user: state.user }
        },
      },
    },
    mfa: {
      passkey: {
        generateAuthenticationOptions: async () => {
          state.calls.push('generateAuthenticationOptions')
          return { relying_party: 'https://zecca.test', options: { challenge: 'CgsM', rp_id: 'zecca.test', allow_credentials: [{ id: 'AQI', type: 'public-key' }] } }
        },
      },
      submitEnrollMfa: async (args) => {
        state.calls.push(`submitEnrollMfa:${args.credentialIds.join(',')}`)
        await fakeInvokeWithMfa(mfaOp(false), mfaPromises.rootPromise, mfaPromises.submitPromise, emit)
        for (const a of state.user.linked_accounts) if (a.type === 'passkey' && a.credential_id && args.credentialIds.includes(a.credential_id)) a.enrolled_in_mfa = true
        if (!state.user.mfa_methods.some((m) => m.type === 'passkey')) state.user.mfa_methods.push({ type: 'passkey' })
        return {}
      },
      verifyMfa: async () => {
        state.calls.push('verifyMfa')
        await fakeInvokeWithMfa(mfaOp(true), mfaPromises.rootPromise, mfaPromises.submitPromise, emit, true)
        return {}
      },
    },
    mfaPromises,
    user: { get: async () => ({ user: state.user }) },
  }
  /** What the adapter's raw_sign does: signWithUserSigner goes through invokeWithMfa. */
  const sign = async () => {
    state.calls.push('sign')
    await fakeInvokeWithMfa(mfaOp(false), mfaPromises.rootPromise, mfaPromises.submitPromise, emit)
    return 'signature'
  }
  return { client, sign, state, listenerCount: () => listeners.size }
}
