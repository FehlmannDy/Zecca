import { describe, expect, it, vi } from 'vitest'
import { fakeCredentials, fakePrivy } from './fake-privy'
import { installMfaHandler, PasskeyMfaError } from './mfa-handler'

const ORIGIN = 'https://zecca.test'

describe('installMfaHandler', () => {
  it('answers mfaRequired with a passkey assertion so the raw sign continues', async () => {
    const p = fakePrivy({ enrolled: true })
    const creds = fakeCredentials()
    const onPrompt = vi.fn()
    const onDone = vi.fn()
    const h = installMfaHandler(p.client, { credentials: creds, origin: ORIGIN, onPrompt, onDone })

    await expect(p.sign()).resolves.toBe('signature')

    expect(onPrompt).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith({ ok: true })
    expect(p.state.calls).toContain('generateAuthenticationOptions')
    const req = creds.calls.get[0].publicKey!
    expect(Array.from(new Uint8Array(req.challenge as ArrayBuffer))).toEqual([10, 11, 12])
    expect(req.userVerification).toBe('required')
    expect(req.rpId).toBe('zecca.test')
    expect(h.phase()).toBe('idle')
    h.uninstall()
  })

  it('does nothing when the signature needs no MFA', async () => {
    const p = fakePrivy({ enrolled: false })
    const creds = fakeCredentials()
    const onPrompt = vi.fn()
    installMfaHandler(p.client, { credentials: creds, origin: ORIGIN, onPrompt })
    await expect(p.sign()).resolves.toBe('signature')
    expect(onPrompt).not.toHaveBeenCalled()
    expect(creds.calls.get).toHaveLength(0)
  })

  it('prompts once per signature while Privy asks every time, and not while a verification is still valid', async () => {
    const every = fakePrivy({ enrolled: true, verifiedForMs: 0 })
    const c1 = fakeCredentials()
    installMfaHandler(every.client, { credentials: c1, origin: ORIGIN })
    await every.sign()
    await every.sign()
    expect(c1.calls.get).toHaveLength(2)

    const cached = fakePrivy({ enrolled: true, verifiedForMs: 60_000 })
    const c2 = fakeCredentials()
    installMfaHandler(cached.client, { credentials: c2, origin: ORIGIN })
    await cached.sign()
    await cached.sign()
    expect(c2.calls.get).toHaveLength(1)
  })

  it('fails the signature at once, in plain words, when the person cancels Face ID', async () => {
    const p = fakePrivy({ enrolled: true })
    const notAllowed = Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' })
    const creds = fakeCredentials({ get: async () => Promise.reject(notAllowed) })
    const onDone = vi.fn()
    const h = installMfaHandler(p.client, { credentials: creds, origin: ORIGIN, onDone })

    const err = await p.sign().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PasskeyMfaError)
    expect((err as PasskeyMfaError).type).toBe('mfa_canceled')
    expect((err as Error).message).toBe('Face ID was cancelled. Nothing was sent.')
    expect(onDone).toHaveBeenCalledWith({ ok: false, error: err })
    expect(h.phase()).toBe('idle')
  })

  it('gives up after the deadline: aborts the prompt and fails the signature instead of hanging', async () => {
    const p = fakePrivy({ enrolled: true })
    let signal: AbortSignal | undefined
    const creds = fakeCredentials({
      get: (o) =>
        new Promise((_, reject) => {
          signal = o.signal ?? undefined
          o.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }),
    })
    installMfaHandler(p.client, { credentials: creds, origin: ORIGIN, deadlineMs: 30 })
    const t0 = Date.now()
    const err = await p.sign().catch((e: unknown) => e)
    expect(Date.now() - t0).toBeLessThan(2000)
    expect((err as PasskeyMfaError).type).toBe('mfa_timeout')
    expect((err as Error).message).toBe('Face ID took too long. Nothing was sent. Try again.')
    expect(signal?.aborted).toBe(true)
  })

  it('stops after a passkey Privy refuses, instead of waiting for another code', async () => {
    const p = fakePrivy({ enrolled: true, acceptSignature: 'something-else' })
    const creds = fakeCredentials()
    const onDone = vi.fn()
    installMfaHandler(p.client, { credentials: creds, origin: ORIGIN, onDone })
    const err = await p.sign().catch((e: unknown) => e)
    expect((err as PasskeyMfaError).type).toBe('mfa_canceled')
    expect((err as Error).message).toBe("Face ID didn't match this account. Nothing was sent.")
    expect(creds.calls.get).toHaveLength(1)
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ ok: false }))
  })

  it('waits for a gesture when the page asks for one before the prompt', async () => {
    const p = fakePrivy({ enrolled: true })
    const creds = fakeCredentials()
    let release!: () => void
    const beforePrompt = vi.fn(() => new Promise<void>((r) => (release = r)))
    installMfaHandler(p.client, { credentials: creds, origin: ORIGIN, beforePrompt })
    const signing = p.sign()
    await vi.waitFor(() => expect(beforePrompt).toHaveBeenCalled())
    expect(creds.calls.get).toHaveLength(0)
    release()
    await expect(signing).resolves.toBe('signature')
    expect(creds.calls.get).toHaveLength(1)
  })

  it('uninstall removes the listener', () => {
    const p = fakePrivy({ enrolled: true })
    const h = installMfaHandler(p.client, { credentials: fakeCredentials(), origin: ORIGIN })
    expect(p.listenerCount()).toBe(1)
    h.uninstall()
    expect(p.listenerCount()).toBe(0)
  })

  it('logs each step without the assertion itself', async () => {
    const p = fakePrivy({ enrolled: true })
    const log = vi.fn()
    installMfaHandler(p.client, { credentials: fakeCredentials(), origin: ORIGIN, log })
    await p.sign()
    const events = log.mock.calls.map((c) => c[0])
    expect(events).toEqual(['mfa:required', 'mfa:options', 'mfa:assertion', 'mfa:submitted', 'mfa:verified'])
    expect(JSON.stringify(log.mock.calls)).not.toContain('Bwg')
  })
})
