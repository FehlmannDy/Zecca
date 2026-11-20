// Shaping between Privy's passkey endpoints (snake_case, base64url) and the browser's WebAuthn API (ArrayBuffers).
// Registration: client.auth.passkey.generateRegistrationOptions -> creationOptionsFromPrivy -> navigator.credentials.create
//               -> registrationJsonFromCredential -> client.auth.passkey.linkWithPasskey (it converts to snake_case itself).
// MFA:          client.mfa.passkey.generateAuthenticationOptions -> requestOptionsFromPrivy -> navigator.credentials.get
//               -> mfaAssertionFromCredential -> the mfaCode Privy's iframe expects (same shape as @privy-io/react-auth).
import { base64UrlToBuffer, bytesToBase64Url } from './encoding'

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec | null => (typeof v === 'object' && v !== null ? (v as Rec) : null)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** The browser credential, as far as this code reads it (PublicKeyCredential in a browser, a fake in tests). */
export type BrowserCredential = {
  id: string
  rawId: ArrayBuffer
  type: string
  authenticatorAttachment?: string | null
  response: {
    clientDataJSON: ArrayBuffer
    attestationObject?: ArrayBuffer
    getTransports?: () => string[]
    authenticatorData?: ArrayBuffer
    signature?: ArrayBuffer
    userHandle?: ArrayBuffer | null
  }
  getClientExtensionResults(): Record<string, unknown>
}

/** Privy's PasskeyAuthenticatorVerifyResponse (api-types), sent as mfaCode with mfaMethod 'passkey'. */
export type PrivyPasskeyAssertion = {
  id: string
  raw_id: string
  type: 'public-key'
  authenticator_attachment?: string
  response: { client_data_json: string; authenticator_data: string; signature: string; user_handle?: string }
  client_extension_results: { app_id?: boolean; cred_props?: unknown; hmac_create_secret?: boolean }
}

/** simplewebauthn's RegistrationResponseJSON, which linkWithPasskey takes. */
export type RegistrationJson = {
  id: string
  rawId: string
  type: string
  authenticatorAttachment?: string
  response: { clientDataJSON: string; attestationObject: string; transports: string[] }
  clientExtensionResults: Record<string, unknown>
}

function descriptors(value: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry) => {
    const d = rec(entry)
    if (!d || !str(d.id) || d.type !== 'public-key') return []
    const transports = Array.isArray(d.transports) ? (d.transports.filter(str) as AuthenticatorTransport[]) : []
    return [{ id: base64UrlToBuffer(d.id), type: 'public-key' as const, ...(transports.length ? { transports } : {}) }]
  })
}

function extensions(value: unknown): AuthenticationExtensionsClientInputs | undefined {
  const e = rec(value)
  if (!e) return undefined
  const out: AuthenticationExtensionsClientInputs = {}
  if (str(e.app_id)) out.appid = e.app_id
  if (e.cred_props !== undefined && e.cred_props !== null) out.credProps = typeof e.cred_props === 'boolean' ? e.cred_props : true
  if (typeof e.hmac_create_secret === 'boolean') (out as Rec).hmacCreateSecret = e.hmac_create_secret
  return Object.keys(out).length ? out : undefined
}

/** From client.auth.passkey.generateRegistrationOptions() to navigator.credentials.create({ publicKey }). */
export function creationOptionsFromPrivy(response: unknown): PublicKeyCredentialCreationOptions {
  const o = rec(rec(response)?.options)
  const rp = rec(o?.rp)
  const user = rec(o?.user)
  if (!o || !str(o.challenge) || !rp || !str(rp.name) || !user || !str(user.id) || !str(user.name)) {
    throw new Error('Privy did not return passkey registration options')
  }
  const algs = Array.isArray(o.pub_key_cred_params)
    ? o.pub_key_cred_params.flatMap((p) => (typeof rec(p)?.alg === 'number' ? [{ type: 'public-key' as const, alg: rec(p)!.alg as number }] : []))
    : []
  if (algs.length === 0) throw new Error('Privy did not return passkey algorithms')
  const sel = rec(o.authenticator_selection)
  const selection: AuthenticatorSelectionCriteria | undefined = sel
    ? {
        ...(str(sel.authenticator_attachment) ? { authenticatorAttachment: sel.authenticator_attachment as AuthenticatorAttachment } : {}),
        ...(str(sel.resident_key) ? { residentKey: sel.resident_key as ResidentKeyRequirement } : {}),
        ...(str(sel.user_verification) ? { userVerification: sel.user_verification as UserVerificationRequirement } : {}),
        ...(typeof sel.require_resident_key === 'boolean' ? { requireResidentKey: sel.require_resident_key } : {}),
      }
    : undefined
  const exclude = descriptors(o.exclude_credentials)
  const ext = extensions(o.extensions)
  return {
    challenge: base64UrlToBuffer(o.challenge),
    rp: { name: rp.name, ...(str(rp.id) ? { id: rp.id } : {}) },
    user: { id: base64UrlToBuffer(user.id), name: user.name, displayName: str(user.display_name) ? user.display_name : user.name },
    pubKeyCredParams: algs,
    ...(typeof o.timeout === 'number' ? { timeout: o.timeout } : {}),
    ...(str(o.attestation) ? { attestation: o.attestation as AttestationConveyancePreference } : {}),
    ...(selection ? { authenticatorSelection: selection } : {}),
    ...(exclude ? { excludeCredentials: exclude } : {}),
    ...(ext ? { extensions: ext } : {}),
  }
}

/** From client.mfa.passkey.generateAuthenticationOptions() to navigator.credentials.get({ publicKey }). */
export function requestOptionsFromPrivy(response: unknown): PublicKeyCredentialRequestOptions {
  const o = rec(rec(response)?.options)
  if (!o || !str(o.challenge)) throw new Error('Privy did not return passkey verification options')
  const allow = descriptors(o.allow_credentials)
  const ext = extensions(o.extensions)
  return {
    challenge: base64UrlToBuffer(o.challenge),
    ...(str(o.rp_id) ? { rpId: o.rp_id } : {}),
    ...(allow ? { allowCredentials: allow } : {}),
    ...(typeof o.timeout === 'number' ? { timeout: o.timeout } : {}),
    userVerification: (str(o.user_verification) ? o.user_verification : 'required') as UserVerificationRequirement,
    ...(ext ? { extensions: ext } : {}),
  }
}

function credentialBase(value: unknown): BrowserCredential {
  const c = value as BrowserCredential | null
  if (!c || !str(c.id) || !str(c.type) || !(c.rawId instanceof ArrayBuffer) || !c.response || typeof c.getClientExtensionResults !== 'function') {
    throw new Error('The passkey did not answer')
  }
  return c
}

/** A new credential from navigator.credentials.create, as linkWithPasskey takes it. */
export function registrationJsonFromCredential(value: unknown): RegistrationJson {
  const c = credentialBase(value)
  if (!(c.response.attestationObject instanceof ArrayBuffer)) throw new Error('The passkey did not answer')
  return {
    id: c.id,
    rawId: bytesToBase64Url(c.rawId),
    type: c.type,
    ...(str(c.authenticatorAttachment) ? { authenticatorAttachment: c.authenticatorAttachment } : {}),
    response: {
      clientDataJSON: bytesToBase64Url(c.response.clientDataJSON),
      attestationObject: bytesToBase64Url(c.response.attestationObject),
      transports: c.response.getTransports?.() ?? [],
    },
    clientExtensionResults: c.getClientExtensionResults(),
  }
}

/** An assertion from navigator.credentials.get, as the mfaCode Privy's iframe verifies. */
export function mfaAssertionFromCredential(value: unknown): PrivyPasskeyAssertion {
  const c = credentialBase(value)
  const r = c.response
  if (!(r.authenticatorData instanceof ArrayBuffer) || !(r.signature instanceof ArrayBuffer)) throw new Error('The passkey did not answer')
  const ext = c.getClientExtensionResults() as Rec
  const results: PrivyPasskeyAssertion['client_extension_results'] = {}
  if (typeof ext.appid === 'boolean') results.app_id = ext.appid
  if (ext.credProps !== undefined) results.cred_props = ext.credProps
  if (typeof ext.hmacCreateSecret === 'boolean') results.hmac_create_secret = ext.hmacCreateSecret
  return {
    id: c.id,
    raw_id: bytesToBase64Url(c.rawId),
    type: 'public-key',
    ...(str(c.authenticatorAttachment) ? { authenticator_attachment: c.authenticatorAttachment } : {}),
    response: {
      client_data_json: bytesToBase64Url(r.clientDataJSON),
      authenticator_data: bytesToBase64Url(r.authenticatorData),
      signature: bytesToBase64Url(r.signature),
      ...(r.userHandle instanceof ArrayBuffer ? { user_handle: bytesToBase64Url(r.userHandle) } : {}),
    },
    client_extension_results: results,
  }
}
