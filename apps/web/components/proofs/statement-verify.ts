// "Check signature" on the statement page, in the browser: the same canonical JSON and SHA-256 as the API
// (services/api/src/connectors/proofs/statement.ts), then ripple-keypairs verify against the key the statement carries.
import * as rk from 'ripple-keypairs'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Statement } from '@zecca/contracts'

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isSafeInteger(value)) throw new TypeError('canonical JSON carries integers only')
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

export type SignatureCheck = { ok: true; signerAddress: string } | { ok: false; reason: string }

export function checkSignature(s: Statement): SignatureCheck {
  try {
    const { signature, ...rest } = s
    const digest = bytesToHex(sha256(utf8ToBytes(canonicalJson(rest))))
    if (digest !== signature.signedPayloadSha256.toLowerCase()) return { ok: false, reason: 'The content does not match what Zecca signed.' }
    if (!rk.verify(digest.toUpperCase(), signature.value, signature.publicKey)) return { ok: false, reason: 'The signature does not match the public key.' }
    return { ok: true, signerAddress: rk.deriveAddress(signature.publicKey) }
  } catch {
    return { ok: false, reason: 'The signature could not be read.' }
  }
}

export function statementTotals(s: Statement) {
  let inMinor = 0
  let outMinor = 0
  let feeMinor = 0
  for (const l of s.lines) {
    if (l.direction === 'in') inMinor += l.amountMinor
    else outMinor += l.amountMinor
    feeMinor += l.feeMinor
  }
  return { inMinor, outMinor, feeMinor, count: s.lines.length }
}

/**
 * Whether `signer` is Zecca's statement key, as Zecca's public config publishes it (addresses.statementSigner).
 * 'unknown' while the config does not publish one: the page then names the key without calling it Zecca's.
 */
export function signerStatus(signer: string | undefined, config: unknown): 'zecca' | 'other' | 'unknown' {
  const published = (config as { addresses?: { statementSigner?: unknown } } | null | undefined)?.addresses?.statementSigner
  if (!signer || typeof published !== 'string' || !published) return 'unknown'
  return signer === published ? 'zecca' : 'other'
}

/** The statement as a file to save (the signature covers canonical JSON, so the indentation does not matter). */
export function statementFile(s: Statement): { name: string; type: string; text: string } {
  return { name: `zecca-statement-${s.id}.json`, type: 'application/json', text: JSON.stringify(s, null, 2) }
}
