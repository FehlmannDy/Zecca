// WalletSecret (key store shape) -> xrpl.Wallet. Same as the probe's W(seed): ecdsa-secp256k1 unless stated.
import xrpl from 'xrpl'
import type { WalletSecret } from '@zecca/contracts'

export type Wallet = xrpl.Wallet

export function walletFrom(secret: WalletSecret): xrpl.Wallet {
  const w = xrpl.Wallet.fromSeed(secret.seed, { algorithm: (secret.algorithm ?? 'ecdsa-secp256k1') as xrpl.ECDSA })
  if (secret.address && w.classicAddress !== secret.address) {
    throw new Error(`wallet secret does not match its address ${secret.address}`)
  }
  return w
}

/** A fresh wallet as a WalletSecret (bootstrap, tests). */
export function generateWalletSecret(algorithm: WalletSecret['algorithm'] = 'ecdsa-secp256k1'): WalletSecret {
  const w = xrpl.Wallet.generate(algorithm as xrpl.ECDSA)
  return { address: w.classicAddress, seed: w.seed!, algorithm }
}
