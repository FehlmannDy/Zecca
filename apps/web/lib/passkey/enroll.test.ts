import { describe, expect, it } from 'vitest'
import { enrollPasskeyMfa, linkPasskey, passkeyStatus, verifyPasskeyNow } from './enroll'
import { fakeCredentials, fakePrivy } from './fake-privy'
import { installMfaHandler } from './mfa-handler'
import { getPrivyClient } from './privy-client'

describe('getPrivyClient', () => {
  it("reads the adapter's js-sdk-core client, from the adapter or the { manager, adapter } handle", () => {
    const { client } = fakePrivy()
    const adapter = { session: { client } }
    expect(getPrivyClient(adapter)).toBe(client)
    expect(getPrivyClient({ manager: {}, adapter })).toBe(client)
  })
  it('says to sign in first before the client exists', () => {
    expect(() => getPrivyClient({ session: {} })).toThrow('Sign in first to add Face ID.')
    expect(() => getPrivyClient(null)).toThrow('Sign in first to add Face ID.')
  })
})

describe('passkeyStatus', () => {
  it('lists linked passkeys and whether one is enrolled for MFA', () => {
    expect(passkeyStatus({ id: 'u', linked_accounts: [{ type: 'email' }], mfa_methods: [] })).toEqual({ credentialIds: [], enrolled: false })
    expect(
      passkeyStatus({
        id: 'u',
        linked_accounts: [{ type: 'passkey', credential_id: 'a' }, { type: 'passkey', credential_id: 'b' }, { type: 'passkey' }],
        mfa_methods: [{ type: 'passkey' }],
      }),
    ).toEqual({ credentialIds: ['a', 'b'], enrolled: true })
  })
})

describe('linkPasskey', () => {
  it('creates a credential from Privy registration options and links it with the same relying party', async () => {
    const p = fakePrivy()
    const creds = fakeCredentials()
    const r = await linkPasskey(p.client, { credentials: creds })
    expect(r.credentialId).toBe('cred-1')
    expect(p.state.calls).toEqual(['generateRegistrationOptions', 'linkWithPasskey:cred-1:https://zecca.test'])
    const pk = creds.calls.create[0].publicKey!
    expect(Array.from(new Uint8Array(pk.challenge as ArrayBuffer))).toEqual([1, 2, 3])
    expect(passkeyStatus(r.user).credentialIds).toEqual(['cred-1'])
  })
  it('says the passkey was cancelled when the person dismisses the prompt', async () => {
    const p = fakePrivy()
    const creds = { ...fakeCredentials(), create: async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })) }
    await expect(linkPasskey(p.client, { credentials: creds })).rejects.toThrow('Face ID was cancelled.')
  })
})

describe('enrollPasskeyMfa', () => {
  it('enrols every linked passkey for MFA and returns the new status', async () => {
    const p = fakePrivy()
    const creds = fakeCredentials()
    await linkPasskey(p.client, { credentials: creds })
    const s = await enrollPasskeyMfa(p.client)
    expect(p.state.calls).toContain('submitEnrollMfa:cred-1')
    expect(s).toEqual({ credentialIds: ['cred-1'], enrolled: true })
  })
  it('asks to add a passkey first when none is linked', async () => {
    await expect(enrollPasskeyMfa(fakePrivy().client)).rejects.toThrow('Add Face ID first.')
  })
})

describe('verifyPasskeyNow', () => {
  it('runs one verification through the installed handler (it prompts once)', async () => {
    const p = fakePrivy({ enrolled: true, verifiedForMs: 60_000 })
    const creds = fakeCredentials()
    installMfaHandler(p.client, { credentials: creds, origin: 'https://zecca.test' })
    await verifyPasskeyNow(p.client)
    expect(creds.calls.get).toHaveLength(1)
    await p.sign()
    expect(creds.calls.get).toHaveLength(1)
  })
})
