// Ported from privy-xrpl-probe/lib.mjs (proven: 28/28 Privy raw_sign signatures tesSUCCESS on Devnet).
// Isomorphic: runs in Node and in the browser (no node:crypto), so the web's mock signer uses it too.
import { encode, encodeForSigning } from 'ripple-binary-codec'
import * as rk from 'ripple-keypairs'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { hashes } from 'xrpl'
import type { RawSign, UserSigner } from '@zecca/contracts'

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('').toUpperCase()
const fromHex = (h: string) => {
  const s = h.replace(/^0x/i, '')
  if (s.length % 2) throw new Error('odd-length hex')
  const out = new Uint8Array(s.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** SHA-512Half of hex input, uppercase hex. */
export function sha512Half(hexInput: string): string {
  return toHex(sha512(fromHex(hexInput)).subarray(0, 32))
}

/** Compact r||s (hex, optional 0x, optional 65th recovery byte) -> canonical uppercase DER, low-S. Other lengths throw. */
export function compactToCanonicalDer(sigHex: string): { der: string; notes: string[] } {
  let h = sigHex.replace(/^0x/i, '')
  const notes: string[] = []
  if (h.length === 130) {
    notes.push('65-byte sig, dropped recovery byte')
    h = h.slice(0, 128)
  }
  if (h.length !== 128) throw new Error(`unexpected raw_sign signature length ${h.length / 2} bytes`)
  let sig = secp256k1.Signature.fromBytes(fromHex(h), 'compact')
  if (sig.s > N / 2n) {
    sig = new secp256k1.Signature(sig.r, N - sig.s)
    notes.push('high-S normalized')
  }
  return { der: sig.toHex('der').toUpperCase(), notes }
}

export type RawHashSigner = UserSigner & { kind: string; rawSign: RawSign; sign(tx: Record<string, unknown>): Promise<{ tx_blob: string; hash: string; notes: string[] }> }

/** Generic raw-hash signer (Privy raw_sign or a local stand-in). rawSign(hash0x) -> compact hex. */
export function rawHashSigner(kind: string, publicKeyIn: string, rawSign: RawSign): RawHashSigner {
  const publicKey = publicKeyIn.replace(/^0x/i, '').toUpperCase()
  return {
    kind,
    address: rk.deriveAddress(publicKey),
    publicKey,
    rawSign,
    async sign(txIn) {
      const tx: Record<string, unknown> = { ...txIn, SigningPubKey: publicKey }
      delete tx.TxnSignature
      const pre = encodeForSigning(tx as never)
      const hash = sha512Half(pre)
      const raw = await rawSign('0x' + hash)
      const { der, notes } = compactToCanonicalDer(raw)
      if (!rk.verify(pre, der, publicKey)) throw new Error('local verify of raw_sign signature FAILED')
      tx.TxnSignature = der
      const blob = encode(tx as never)
      return { tx_blob: blob, hash: hashes.hashSignedTx(blob), notes }
    },
  }
}

export type MockRawSigner = RawHashSigner & { seed: string }

/**
 * Local stand-in for Privy raw_sign: same I/O contract (0x hash in, compact r||s hex out).
 * lowS:false on purpose so the DER/low-S path is exercised. Pass a seed to restore a key (the web keeps it in localStorage).
 */
export function mockRawSigner(seed?: string): MockRawSigner {
  const s = seed ?? rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })
  const { privateKey, publicKey } = rk.deriveKeypair(s)
  const sk = fromHex(privateKey.slice(-64))
  const rawSign: RawSign = async (h) => '0x' + toHex(secp256k1.sign(fromHex(h), sk, { prehash: false, lowS: false }))
  return Object.assign(rawHashSigner('rawsign-mock', publicKey, rawSign), { seed: s })
}

/** Hex of the UTF-8 bytes of a message. */
export function messageHex(message: string): string {
  return toHex(new TextEncoder().encode(message))
}

/** Signs SHA-512Half(UTF-8 message) through the raw_sign contract. Returns DER hex (what ripple-keypairs.verify expects). */
export async function signMessage(rawSign: RawSign, message: string): Promise<string> {
  const hash = sha512Half(messageHex(message))
  return compactToCanonicalDer(await rawSign('0x' + hash)).der
}

export function verifyMessage(message: string, derSignature: string, publicKey: string): boolean {
  try {
    return rk.verify(messageHex(message), derSignature, publicKey)
  } catch {
    return false
  }
}

/** Signer backed by a local key (bootstrap scripts, ledger tests). */
export function localKeySigner(seed: string): MockRawSigner {
  return mockRawSigner(seed)
}
