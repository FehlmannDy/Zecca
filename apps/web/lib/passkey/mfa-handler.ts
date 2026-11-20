// Answers Privy's passkey MFA next to the xrpl-connect adapter, which has no MFA code (DECISIONS #7, #13).
// When a raw_sign needs MFA, js-sdk-core emits 'mfaRequired' and waits for rootPromise.current.resolve(...). This
// handler gets authentication options from Privy, calls navigator.credentials.get (on a phone: the Face ID or
// fingerprint prompt), and hands the assertion over so the signature continues. The passkey is not the XRPL key and
// signs no transaction: it proves to Privy that the owner is present, and Privy's signer then signs.
import type { PasskeyPrivyClient } from './privy-client'
import { mfaAssertionFromCredential, requestOptionsFromPrivy } from './webauthn'

export type MfaPhase = 'idle' | 'prompting' | 'verifying'

export class PasskeyMfaError extends Error {
  constructor(
    readonly type: 'mfa_canceled' | 'mfa_timeout',
    message: string,
    readonly reason?: string,
  ) {
    super(message)
    this.name = 'PasskeyMfaError'
  }
}

export type MfaOutcome = { ok: true } | { ok: false; error: PasskeyMfaError }

export type MfaHandlerOptions = {
  credentials?: Pick<CredentialsContainer, 'get'>
  /** Sent to Privy as the relying party, like @privy-io/react-auth does (window.origin). */
  origin?: string
  /**
   * Give up on the prompt after this long: abort it and fail the signature now rather than leave Privy waiting.
   * Keep it under the adapter's timeoutMs (15 s by default in xrpl-connect-privy 1.1.0-rc.0; the app sets 45 s).
   * Default 40 s.
   */
  deadlineMs?: number
  /** 'Face ID' (default) or 'fingerprint': only the wording of the errors. */
  word?: 'Face ID' | 'fingerprint'
  /** Awaited just before the browser prompt, e.g. for a page that must collect a tap first (Safari's gesture rule). */
  beforePrompt?: (signal: AbortSignal) => Promise<void>
  onPrompt?: () => void
  onDone?: (outcome: MfaOutcome) => void
  /** Step names only; never the assertion or the options. */
  log?: (event: string, detail?: Record<string, unknown>) => void
}

export type MfaHandler = { uninstall(): void; phase(): MfaPhase }

const ROOT_WAIT_MS = 2000

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms))
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

export function installMfaHandler(client: PasskeyPrivyClient, opts: MfaHandlerOptions = {}): MfaHandler {
  const credentials = opts.credentials ?? (typeof navigator !== 'undefined' ? navigator.credentials : undefined)
  const origin = opts.origin ?? (typeof window !== 'undefined' ? window.location.origin : '')
  const deadlineMs = opts.deadlineMs ?? 40_000
  const word = opts.word ?? 'Face ID'
  const subject = word === 'Face ID' ? 'Face ID' : 'The fingerprint check'
  const log = opts.log ?? (() => {})
  const mp = client.mfaPromises
  let phase: MfaPhase = 'idle'

  const errors = {
    canceled: () => new PasskeyMfaError('mfa_canceled', `${subject} was cancelled. Nothing was sent.`, 'canceled'),
    timeout: () => new PasskeyMfaError('mfa_timeout', `${subject} took too long. Nothing was sent. Try again.`, 'timeout'),
    refused: () => new PasskeyMfaError('mfa_canceled', `${word} didn't match this account. Nothing was sent.`, 'refused'),
    failed: () => new PasskeyMfaError('mfa_canceled', `${word} couldn't start. Nothing was sent. Try again.`, 'failed'),
  }

  /** js-sdk-core replaces rootPromise.current right after emitting; wait for the deferred that is not `old`. */
  async function waitingRoot(old: unknown) {
    const until = Date.now() + ROOT_WAIT_MS
    for (;;) {
      const cur = mp.rootPromise.current
      if (cur && cur !== old) return cur
      if (Date.now() > until) return null
      await sleep(cur ? 5 : 0)
    }
  }

  async function answer(stale: unknown) {
    phase = 'prompting'
    log('mfa:required')
    opts.onPrompt?.()
    const abort = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, deadlineMs)
    let answered: unknown = stale
    try {
      if (!credentials) throw errors.failed()
      const init = await raceAbort(client.mfa.passkey.generateAuthenticationOptions({}), abort.signal)
      log('mfa:options')
      if (opts.beforePrompt) await raceAbort(opts.beforePrompt(abort.signal), abort.signal)
      const credential = await credentials.get({ publicKey: requestOptionsFromPrivy(init), signal: abort.signal })
      const mfaCode = mfaAssertionFromCredential(credential)
      log('mfa:assertion')
      clearTimeout(timer)
      const root = await waitingRoot(stale)
      if (!root) throw errors.failed()
      phase = 'verifying'
      const verified = new Promise<void>((resolve, reject) => {
        mp.submitPromise.current = { resolve: () => resolve(), reject }
      })
      answered = root
      root.resolve({ mfaMethod: 'passkey', mfaCode, relyingParty: origin })
      log('mfa:submitted')
      await verified.catch((e: unknown) => {
        throw (e as { type?: string })?.type === 'mfa_timeout' ? errors.timeout() : errors.refused()
      })
      log('mfa:verified')
      phase = 'idle'
      opts.onDone?.({ ok: true })
    } catch (e) {
      clearTimeout(timer)
      const name = (e as { name?: string })?.name
      const error = e instanceof PasskeyMfaError ? e : timedOut ? errors.timeout() : name === 'NotAllowedError' || name === 'AbortError' ? errors.canceled() : errors.failed()
      log('mfa:failed', { reason: error.reason, name })
      // Privy is waiting (up to 300 s) for a code: cancel it so the signature fails now with our message.
      const waiting = await waitingRoot(answered)
      waiting?.reject(error)
      phase = 'idle'
      opts.onDone?.({ ok: false, error })
    }
  }

  const onRequired = () => {
    if (phase !== 'idle') return log('mfa:required-while-busy')
    // Capture the old deferred now: js-sdk-core sets the new one synchronously after this emit returns.
    void answer(mp.rootPromise.current)
  }
  mp.on('mfaRequired', onRequired)
  return {
    uninstall: () => void mp.off('mfaRequired', onRequired),
    phase: () => phase,
  }
}
