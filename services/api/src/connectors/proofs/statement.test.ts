import { describe, expect, it } from 'vitest'
import * as rk from 'ripple-keypairs'
import { createHash } from 'node:crypto'
import { Statement } from '@zecca/contracts'
import { statement as fixture } from '@zecca/contracts/fixtures'
import { canonicalJson, payloadOf, signStatement, statementKeyFrom, verifyStatement } from './statement'

const seed = rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })
const key = statementKeyFrom({ address: rk.deriveAddress(rk.deriveKeypair(seed).publicKey), seed, algorithm: 'ecdsa-secp256k1' })
const { signature: _drop, ...unsigned } = fixture

describe('canonical JSON', () => {
  it('sorts keys at every depth, keeps array order, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 'x' }], c: true } })).toBe('{"a":{"c":true,"d":[3,{"y":"x","z":1}]},"b":1}')
  })
  it('drops undefined fields and escapes strings like JSON', () => {
    expect(canonicalJson({ a: undefined, b: 'Caffè "Bruno"\n' })).toBe('{"b":"Caffè \\"Bruno\\"\\n"}')
  })
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }))
  })
  it('refuses what JSON cannot carry exactly (floats, NaN, functions)', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow()
    expect(() => canonicalJson({ a: Number.NaN })).toThrow()
    expect(() => canonicalJson({ a: () => 1 })).toThrow()
  })
  it('the payload is the statement without its signature', () => {
    expect(payloadOf(fixture)).toBe(canonicalJson(unsigned))
    expect(payloadOf(fixture)).not.toContain('signature')
  })
})

describe('statement signature', () => {
  it('round trip: signs SHA-256 of the canonical payload with the statement key; anyone verifies with the public key', () => {
    const s = signStatement(unsigned, key)
    expect(Statement.parse(s)).toEqual(s)
    expect(s.signature.alg).toBe('secp256k1')
    expect(s.signature.publicKey).toBe(key.publicKey)
    expect(s.signature.signedPayloadSha256).toBe(createHash('sha256').update(payloadOf(s), 'utf8').digest('hex'))
    expect(rk.verify(s.signature.signedPayloadSha256.toUpperCase(), s.signature.value, s.signature.publicKey)).toBe(true)
    expect(verifyStatement(s)).toEqual({ ok: true, signerAddress: key.address })
  })

  it('a statement that survives a JSON round trip (any key order) still verifies', () => {
    const s = signStatement(unsigned, key)
    const shuffled = JSON.parse(JSON.stringify({ signature: s.signature, lines: s.lines, id: s.id, holder: s.holder, attestation: s.attestation, createdAt: s.createdAt }))
    expect(verifyStatement(shuffled).ok).toBe(true)
  })

  it('any change to a line breaks it', () => {
    const s = signStatement(unsigned, key)
    const tampered = { ...s, lines: [{ ...s.lines[0], amountMinor: s.lines[0].amountMinor + 1 }] }
    expect(verifyStatement(tampered)).toMatchObject({ ok: false, reason: 'digest' })
  })

  it('a forged signature with a matching digest is refused', () => {
    const s = signStatement(unsigned, key)
    const other = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' }))
    const forged = { ...s, signature: { ...s.signature, value: rk.sign(s.signature.signedPayloadSha256.toUpperCase(), other.privateKey) } }
    expect(verifyStatement(forged)).toMatchObject({ ok: false, reason: 'signature' })
  })

  it('refuses a key store wallet that is not secp256k1', () => {
    const ed = rk.generateSeed({ algorithm: 'ed25519' })
    expect(() => statementKeyFrom({ address: rk.deriveAddress(rk.deriveKeypair(ed).publicKey), seed: ed, algorithm: 'ed25519' })).toThrow(/secp256k1/)
  })
})
