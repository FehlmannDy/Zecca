import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import { walletFrom } from './wallet'

describe('walletFrom', () => {
  it('restores an ecdsa-secp256k1 wallet from a WalletSecret', () => {
    const w = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
    const r = walletFrom({ address: w.classicAddress, seed: w.seed!, algorithm: 'ecdsa-secp256k1' })
    expect(r.classicAddress).toBe(w.classicAddress)
    expect(r.publicKey).toBe(w.publicKey)
  })

  it('defaults to ecdsa-secp256k1 like the probe W(seed)', () => {
    const w = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
    const r = walletFrom({ address: w.classicAddress, seed: w.seed! } as never)
    expect(r.classicAddress).toBe(w.classicAddress)
  })

  it('supports ed25519', () => {
    const w = xrpl.Wallet.generate(xrpl.ECDSA.ed25519)
    expect(walletFrom({ address: w.classicAddress, seed: w.seed!, algorithm: 'ed25519' }).publicKey).toMatch(/^ED/)
  })

  it('refuses a secret whose seed does not derive the stored address, without echoing the seed', () => {
    const a = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
    const b = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
    let msg = ''
    try {
      walletFrom({ address: b.classicAddress, seed: a.seed!, algorithm: 'ecdsa-secp256k1' })
    } catch (e) {
      msg = String((e as Error).message)
    }
    expect(msg).toMatch(/does not match/)
    expect(msg).not.toContain(a.seed!)
  })
})
