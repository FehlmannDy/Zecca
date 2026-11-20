import { describe, expect, it } from 'vitest'
import { approveLabel, biometricWord, isPasskeyAvailable, passkeyFeatureOn } from './availability'

describe('passkeyFeatureOn', () => {
  it('is on only with the flag and the Privy signer', () => {
    expect(passkeyFeatureOn(null)).toBe(false)
    expect(passkeyFeatureOn({ signerMode: 'privy', features: { passkey: true } })).toBe(true)
    expect(passkeyFeatureOn({ signerMode: 'privy', features: { passkey: false } })).toBe(false)
    expect(passkeyFeatureOn({ signerMode: 'privy', features: {} })).toBe(false)
    expect(passkeyFeatureOn({ signerMode: 'mock', features: { passkey: true } })).toBe(false)
  })
})

describe('isPasskeyAvailable', () => {
  it('asks the platform for a user-verifying authenticator', async () => {
    const yes = { PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true } }
    const no = { PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => false } }
    await expect(isPasskeyAvailable(yes)).resolves.toBe(true)
    await expect(isPasskeyAvailable(no)).resolves.toBe(false)
  })
  it('is false without WebAuthn, or when the check throws', async () => {
    await expect(isPasskeyAvailable({})).resolves.toBe(false)
    await expect(isPasskeyAvailable(undefined)).resolves.toBe(false)
    const throws = { PublicKeyCredential: { isUserVerifyingPlatformAuthenticatorAvailable: async () => Promise.reject(new Error('x')) } }
    await expect(isPasskeyAvailable(throws)).resolves.toBe(false)
  })
})

describe('biometricWord', () => {
  it('says fingerprint on Android, Face ID elsewhere', () => {
    expect(biometricWord('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/131 Mobile Safari/537.36')).toBe('fingerprint')
    expect(biometricWord('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile/15E148 Safari/604.1')).toBe('Face ID')
    expect(biometricWord('')).toBe('Face ID')
  })
})

describe('approveLabel', () => {
  const on = { featureOn: true, available: true, enrolled: true, word: 'Face ID' as const }
  it('reads "Approve with Face ID" only when the flag is on, the phone has it and it is enrolled', () => {
    expect(approveLabel(on)).toBe('Approve with Face ID')
    expect(approveLabel({ ...on, word: 'fingerprint' })).toBe('Approve with fingerprint')
  })
  it('falls back to "Approve" otherwise, never promising Face ID', () => {
    expect(approveLabel({ ...on, featureOn: false })).toBe('Approve')
    expect(approveLabel({ ...on, available: false })).toBe('Approve')
    expect(approveLabel({ ...on, enrolled: false })).toBe('Approve')
  })
})
