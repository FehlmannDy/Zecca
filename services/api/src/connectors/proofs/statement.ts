// Statements (SPEC §4.10): canonical JSON, SHA-256, secp256k1 signature with Zecca's statement key.
//
// What is signed, so anyone can check it with any secp256k1 library:
//   payload   = canonical JSON of the statement without its `signature` field
//               (object keys sorted by code unit at every depth, no whitespace, arrays in order, undefined dropped)
//   digest    = SHA-256(UTF-8 payload)                      -> signature.signedPayloadSha256 (lowercase hex)
//   signature = ripple-keypairs sign(digest, statementKey)  -> signature.value (DER hex)
//               i.e. ECDSA secp256k1 over SHA-512Half(digest), low-S, as every XRPL signature.
// The statement key is the key store's 'kycIssuer' wallet (secp256k1). Its address is the account that issues
// Zecca's on-ledger identity credentials, so the public key can be tied to a public XRPL account.
import { createHash } from 'node:crypto'
import * as rk from 'ripple-keypairs'
import type { Statement, WalletSecret } from '@zecca/contracts'

export type UnsignedStatement = Omit<Statement, 'signature'>
export type StatementKey = { address: string; publicKey: string; privateKey: string }

/** Canonical JSON: sorted keys at every depth, no whitespace. Only integers, strings, booleans, null, arrays, objects. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonical JSON carries integers only, got ${value}`)
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
      const o = value as Record<string, unknown>
      const keys = Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
    }
    default:
      throw new TypeError(`canonical JSON cannot carry a ${typeof value}`)
  }
}

/** The signed bytes: the statement minus its signature, canonicalised. */
export function payloadOf(s: UnsignedStatement | Statement): string {
  const { signature: _ignored, ...rest } = s as Statement
  return canonicalJson(rest)
}

export const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export function statementKeyFrom(w: WalletSecret): StatementKey {
  if (w.algorithm !== 'ecdsa-secp256k1') throw new Error('the statement key must be a secp256k1 wallet')
  const kp = rk.deriveKeypair(w.seed, { algorithm: 'ecdsa-secp256k1' })
  const address = rk.deriveAddress(kp.publicKey)
  if (address !== w.address) throw new Error('the statement key does not match its address')
  return { address, publicKey: kp.publicKey, privateKey: kp.privateKey }
}

export function signStatement(s: UnsignedStatement, key: StatementKey): Statement {
  const digest = sha256Hex(payloadOf(s))
  return { ...s, signature: { alg: 'secp256k1', publicKey: key.publicKey, value: rk.sign(digest.toUpperCase(), key.privateKey), signedPayloadSha256: digest } }
}

export type VerifyResult = { ok: true; signerAddress: string } | { ok: false; reason: 'digest' | 'signature' | 'malformed' }

/** Recomputes the digest from the content and checks the signature against the public key it carries. */
export function verifyStatement(s: Statement): VerifyResult {
  let digest: string
  try {
    digest = sha256Hex(payloadOf(s))
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (digest !== s.signature.signedPayloadSha256.toLowerCase()) return { ok: false, reason: 'digest' }
  let ok = false
  try {
    ok = rk.verify(digest.toUpperCase(), s.signature.value, s.signature.publicKey)
  } catch {
    ok = false
  }
  return ok ? { ok: true, signerAddress: rk.deriveAddress(s.signature.publicKey) } : { ok: false, reason: 'signature' }
}
