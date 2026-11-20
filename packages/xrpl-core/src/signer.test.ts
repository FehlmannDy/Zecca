import { describe, expect, it } from 'vitest'
import * as rk from 'ripple-keypairs'
import { decode, encodeForSigning } from 'ripple-binary-codec'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { compactToCanonicalDer, rawHashSigner, mockRawSigner, signMessage, verifyMessage, sha512Half, messageHex } from './signer'

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

function keypair() {
  const { privateKey, publicKey } = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' }))
  return { sk: Buffer.from(privateKey.slice(-64), 'hex'), publicKey }
}

describe('compactToCanonicalDer', () => {
  const { sk } = keypair()
  const msg = new Uint8Array(32).fill(7)
  const compact = hex(secp256k1.sign(msg, sk, { prehash: false, lowS: true }))

  it('converts 64-byte compact r||s to uppercase DER', () => {
    const { der, notes } = compactToCanonicalDer(compact)
    expect(der).toMatch(/^30[0-9A-F]+$/)
    expect(notes).toEqual([])
  })
  it('accepts a 0x prefix and drops a 65th recovery byte', () => {
    const { der, notes } = compactToCanonicalDer('0x' + compact + '01')
    expect(der).toBe(compactToCanonicalDer(compact).der)
    expect(notes.join()).toMatch(/recovery byte/)
  })
  it('normalizes high-S to low-S', () => {
    const sig = secp256k1.Signature.fromBytes(Buffer.from(compact, 'hex'), 'compact')
    const high = new secp256k1.Signature(sig.r, N - sig.s)
    const { der, notes } = compactToCanonicalDer(hex(high.toBytes('compact')))
    expect(notes.join()).toMatch(/high-S/)
    expect(der).toBe(compactToCanonicalDer(compact).der)
  })
  it('throws on a wrong length', () => {
    expect(() => compactToCanonicalDer('ab'.repeat(63))).toThrow(/length/)
    expect(() => compactToCanonicalDer('')).toThrow(/length/)
  })
})

describe('rawHashSigner (the raw_sign contract)', () => {
  const tx = {
    TransactionType: 'Payment',
    Account: '',
    Destination: 'rNwvGErbykbsfcRnmq6fXhqmrrL94WcZSZ',
    Amount: '1',
    Fee: '12',
    Sequence: 1,
    LastLedgerSequence: 1000,
  }
  it('signs with a high-S-producing raw signer and the result verifies', async () => {
    const signer = mockRawSigner()
    const { tx_blob, hash } = await signer.sign({ ...tx, Account: signer.address })
    const d = decode(tx_blob) as Record<string, unknown>
    expect(d.SigningPubKey).toBe(signer.publicKey)
    const { TxnSignature, ...unsigned } = d
    expect(rk.verify(encodeForSigning(unsigned as any), TxnSignature as string, signer.publicKey)).toBe(true)
    expect(hash).toMatch(/^[0-9A-F]{64}$/)
  })
  it('refuses a signature that does not verify', async () => {
    const bad = rawHashSigner('bad', keypair().publicKey, async () => '0x' + '11'.repeat(64))
    await expect(bad.sign({ ...tx, Account: bad.address })).rejects.toThrow()
  })
  it('derives the address from the public key', () => {
    const { publicKey } = keypair()
    expect(rawHashSigner('x', publicKey, async () => '').address).toBe(rk.deriveAddress(publicKey))
  })
  it('restores the same mock key from a seed', () => {
    const a = mockRawSigner()
    const b = mockRawSigner(a.seed)
    expect(b.address).toBe(a.address)
  })
})

describe('message signing (nonce auth)', () => {
  it('signs SHA-512Half(utf8) through raw_sign and verifies with ripple-keypairs', async () => {
    const s = mockRawSigner()
    const message = 'Sign in to Zecca\nnonce: 0123456789abcdef0123456789abcdef'
    const sig = await signMessage(s.rawSign, message)
    expect(verifyMessage(message, sig, s.publicKey)).toBe(true)
    expect(verifyMessage(message + 'x', sig, s.publicKey)).toBe(false)
    expect(rk.verify(messageHex(message), sig, s.publicKey)).toBe(true)
  })
  it('sha512Half is the first 32 bytes of SHA-512', () => {
    expect(sha512Half('')).toBe('CF83E1357EEFB8BDF1542850D66D8007D620E4050B5715DC83F4A921D36CE9CE')
  })
})
