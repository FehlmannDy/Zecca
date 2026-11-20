// Per-user custodial Testnet wallets (SPEC §4.7 fallback, D7), held in the key store.
// The KeyStore interface has no per-user wallet slot yet (contract request). Until it has, the secret goes in the
// per-owner key-pair slot under its own owner name, 'earn-testnet:<user address>', as { publicKey: address, privateKey: seed }.
// It is encrypted with the rest of the file and never leaves this module except as an xrpl.Wallet.
import type { KeyStore, WalletSecret } from '@zecca/contracts'
import { generateWalletSecret, walletFrom } from '@zecca/xrpl-core'

const owner = (userAddress: string) => ({ user: `earn-testnet:${userAddress}` })

/** The user's Testnet wallet secret, created on first use. */
export function testnetWalletSecret(keystore: KeyStore, userAddress: string): WalletSecret {
  const o = owner(userAddress)
  if (!keystore.has(o)) {
    const s = generateWalletSecret('ecdsa-secp256k1')
    keystore.setElGamal(o, { publicKey: s.address, privateKey: s.seed })
  }
  const kp = keystore.getElGamal(o)
  return { address: kp.publicKey, seed: kp.privateKey, algorithm: 'ecdsa-secp256k1' }
}

export const testnetWallet = (keystore: KeyStore, userAddress: string) => walletFrom(testnetWalletSecret(keystore, userAddress))
