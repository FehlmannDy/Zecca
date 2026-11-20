import { describe, expect, it } from 'vitest'
import { createMemoryKeyStore } from './memory'

const secret = { address: 'rBCtijgiPFRnLxazz8LMqbkP8zBicWhFxT', seed: 'sEdFAKEFAKEFAKEFAKEFAKEFAKE', algorithm: 'ecdsa-secp256k1' as const }

describe('memory KeyStore', () => {
  it('stores and returns wallets by role', () => {
    const ks = createMemoryKeyStore()
    expect(ks.hasWallet('sponsor')).toBe(false)
    expect(() => ks.getWallet('sponsor')).toThrow(/sponsor/)
    ks.setWallet('sponsor', secret)
    expect(ks.hasWallet('sponsor')).toBe(true)
    expect(ks.getWallet('sponsor')).toEqual(secret)
  })
  it('creates a user ElGamal key once (idempotent)', () => {
    let n = 0
    const ks = createMemoryKeyStore({ generateElGamal: () => ({ publicKey: `PUB${++n}`, privateKey: `PRIV${n}` }) })
    const a = ks.createUserElGamal('rUser1')
    const b = ks.createUserElGamal('rUser1')
    expect(a).toBe('PUB1')
    expect(b).toBe('PUB1')
    expect(ks.has({ user: 'rUser1' })).toBe(true)
    expect(ks.getElGamal({ user: 'rUser1' })).toEqual({ publicKey: 'PUB1', privateKey: 'PRIV1' })
    expect(ks.has({ user: 'rOther' })).toBe(false)
  })
  it('keeps issuer and pool keys and meta', () => {
    const ks = createMemoryKeyStore()
    ks.setElGamal('pool', { publicKey: 'P', privateKey: 'Q' })
    expect(ks.getElGamal('pool').publicKey).toBe('P')
    expect(() => ks.getElGamal('issuer')).toThrow(/issuer/)
    ks.setMeta('cmptIssuanceId', 'ABC')
    expect(ks.getMeta('cmptIssuanceId')).toBe('ABC')
    expect(ks.getMeta('nope')).toBeUndefined()
  })
  it('generates real ElGamal keys by default', () => {
    const ks = createMemoryKeyStore()
    const pub = ks.createUserElGamal('rUser2')
    expect(pub).toMatch(/^[0-9A-Fa-f]{66}$/)
  })
  it('error messages never contain secrets', () => {
    const ks = createMemoryKeyStore()
    ks.setWallet('pool', secret)
    try { ks.getWallet('issuer') } catch (e) { expect(String(e)).not.toContain(secret.seed) }
  })
})
