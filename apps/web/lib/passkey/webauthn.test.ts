import { describe, expect, it } from 'vitest'
import { base64UrlToBytes, bytesToBase64Url } from './encoding'
import { creationOptionsFromPrivy, mfaAssertionFromCredential, registrationJsonFromCredential, requestOptionsFromPrivy } from './webauthn'

const buf = (...bytes: number[]) => new Uint8Array(bytes).buffer

describe('base64url', () => {
  it('round-trips bytes without padding or + and /', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x01])
    const text = bytesToBase64Url(bytes)
    expect(text).toBe('-__-AAE')
    expect(Array.from(base64UrlToBytes(text))).toEqual(Array.from(bytes))
  })
  it('accepts an ArrayBuffer and a view with an offset', () => {
    const backing = new Uint8Array([9, 1, 2, 3, 9])
    expect(bytesToBase64Url(new Uint8Array(backing.buffer, 1, 3))).toBe(bytesToBase64Url(buf(1, 2, 3)))
  })
  it('rejects characters outside the alphabet', () => {
    expect(() => base64UrlToBytes('ab$c')).toThrow()
  })
})

describe('creationOptionsFromPrivy (link a passkey)', () => {
  const linkInit = {
    relying_party: 'https://zecca.test',
    options: {
      challenge: 'AQID',
      rp: { name: 'Zecca', id: 'zecca.test' },
      user: { id: 'BAUG', name: 'ana@zecca.test', display_name: 'ana@zecca.test' },
      pub_key_cred_params: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }, { alg: 'bad' }],
      timeout: 60000,
      attestation: 'none',
      authenticator_selection: { resident_key: 'required', user_verification: 'required', require_resident_key: true },
      exclude_credentials: [{ id: 'BwgJ', type: 'public-key', transports: ['internal'] }, { id: '', type: 'public-key' }],
      extensions: { cred_props: true },
    },
  }

  it('turns Privy snake_case into browser options with byte challenge and user id', () => {
    const o = creationOptionsFromPrivy(linkInit)
    expect(Array.from(new Uint8Array(o.challenge as ArrayBuffer))).toEqual([1, 2, 3])
    expect(Array.from(new Uint8Array(o.user.id as ArrayBuffer))).toEqual([4, 5, 6])
    expect(o.user.name).toBe('ana@zecca.test')
    expect(o.user.displayName).toBe('ana@zecca.test')
    expect(o.rp).toEqual({ name: 'Zecca', id: 'zecca.test' })
    expect(o.pubKeyCredParams).toEqual([{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }])
    expect(o.timeout).toBe(60000)
    expect(o.attestation).toBe('none')
    expect(o.authenticatorSelection).toEqual({ residentKey: 'required', userVerification: 'required', requireResidentKey: true })
    expect(o.excludeCredentials).toHaveLength(1)
    expect(Array.from(new Uint8Array(o.excludeCredentials![0].id as ArrayBuffer))).toEqual([7, 8, 9])
    expect(o.excludeCredentials![0].transports).toEqual(['internal'])
    expect(o.extensions).toEqual({ credProps: true })
  })

  it('refuses options without a challenge, user or algorithm', () => {
    expect(() => creationOptionsFromPrivy({})).toThrow()
    expect(() => creationOptionsFromPrivy({ options: { ...linkInit.options, challenge: '' } })).toThrow()
    expect(() => creationOptionsFromPrivy({ options: { ...linkInit.options, user: undefined } })).toThrow()
    expect(() => creationOptionsFromPrivy({ options: { ...linkInit.options, pub_key_cred_params: [] } })).toThrow()
  })
})

describe('requestOptionsFromPrivy (MFA verification)', () => {
  it('turns the MFA init response into browser request options', () => {
    const o = requestOptionsFromPrivy({
      relying_party: 'https://zecca.test',
      options: {
        challenge: 'CgsM',
        rp_id: 'zecca.test',
        allow_credentials: [{ id: 'DQ4P', type: 'public-key', transports: ['internal', 'hybrid'] }],
        user_verification: 'required',
        timeout: 30000,
      },
    })
    expect(Array.from(new Uint8Array(o.challenge as ArrayBuffer))).toEqual([10, 11, 12])
    expect(o.rpId).toBe('zecca.test')
    expect(o.userVerification).toBe('required')
    expect(o.timeout).toBe(30000)
    expect(o.allowCredentials).toHaveLength(1)
    expect(Array.from(new Uint8Array(o.allowCredentials![0].id as ArrayBuffer))).toEqual([13, 14, 15])
    expect(o.allowCredentials![0].transports).toEqual(['internal', 'hybrid'])
  })
  it('defaults to user verification required (the point is Face ID)', () => {
    expect(requestOptionsFromPrivy({ options: { challenge: 'AQID' } }).userVerification).toBe('required')
  })
  it('refuses a response without a challenge', () => {
    expect(() => requestOptionsFromPrivy({ options: {} })).toThrow()
  })
})

const fakeRegistration = {
  id: 'cred-1',
  rawId: buf(1, 2),
  type: 'public-key',
  authenticatorAttachment: 'platform',
  response: { clientDataJSON: buf(3), attestationObject: buf(4, 5), getTransports: () => ['internal'] },
  getClientExtensionResults: () => ({ credProps: { rk: true } }),
}
const fakeAssertion = {
  id: 'cred-1',
  rawId: buf(1, 2),
  type: 'public-key',
  authenticatorAttachment: 'platform',
  response: { clientDataJSON: buf(3), authenticatorData: buf(6), signature: buf(7, 8), userHandle: buf(9) },
  getClientExtensionResults: () => ({}),
}

describe('registrationJsonFromCredential (for linkWithPasskey)', () => {
  it('encodes every buffer as base64url, camelCase like simplewebauthn', () => {
    expect(registrationJsonFromCredential(fakeRegistration as never)).toEqual({
      id: 'cred-1',
      rawId: 'AQI',
      type: 'public-key',
      authenticatorAttachment: 'platform',
      response: { clientDataJSON: 'Aw', attestationObject: 'BAU', transports: ['internal'] },
      clientExtensionResults: { credProps: { rk: true } },
    })
  })
  it('refuses an assertion or an empty credential', () => {
    expect(() => registrationJsonFromCredential(null)).toThrow()
    expect(() => registrationJsonFromCredential(fakeAssertion as never)).toThrow()
  })
})

describe('mfaAssertionFromCredential (the mfaCode Privy expects)', () => {
  it('is snake_case, base64url, like react-auth sends it', () => {
    expect(mfaAssertionFromCredential(fakeAssertion as never)).toEqual({
      id: 'cred-1',
      raw_id: 'AQI',
      type: 'public-key',
      authenticator_attachment: 'platform',
      response: { client_data_json: 'Aw', authenticator_data: 'Bg', signature: 'Bwg', user_handle: 'CQ' },
      client_extension_results: {},
    })
  })
  it('maps the extension results Privy knows', () => {
    const a = { ...fakeAssertion, getClientExtensionResults: () => ({ appid: true, credProps: { rk: true }, hmacCreateSecret: false }) }
    expect(mfaAssertionFromCredential(a as never).client_extension_results).toEqual({ app_id: true, cred_props: { rk: true }, hmac_create_secret: false })
  })
  it('refuses a registration (no signature)', () => {
    expect(() => mfaAssertionFromCredential(fakeRegistration as never)).toThrow()
    expect(() => mfaAssertionFromCredential(null)).toThrow()
  })
})
