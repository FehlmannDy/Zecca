import { randomBytes } from 'node:crypto'
import xrpl from 'xrpl'
import { decodeAccountID } from 'ripple-address-codec'
import type { ElGamalKeyPair, KeyStore, WalletRole } from '@zecca/contracts'
import { createMemoryKeyStore } from '@zecca/keystore'
import { createMockLedger, type MockLedger } from './mock-ledger'

export { createMockLedger, mockCiphertext } from './mock-ledger'
export type { MockLedger, MockLedgerOptions } from './mock-ledger'

export const ALL_ROLES: WalletRole[] = ['sponsor', 'issuer', 'pool', 'relayer', 'cardSettlement', 'kycIssuer', 'testnetTreasury', 'marketIssuer', 'oracle', 'demoShop']

/** Fills a key store with fresh wallets for every role, issuer + pool ElGamal keys and a random CMPT issuance id (mock only). */
export function seedMockKeyStore(keystore: KeyStore): KeyStore {
  for (const role of ALL_ROLES) {
    if (keystore.hasWallet(role)) continue
    const w = xrpl.Wallet.generate('ecdsa-secp256k1' as never)
    keystore.setWallet(role, { address: w.classicAddress, seed: w.seed!, algorithm: 'ecdsa-secp256k1' })
  }
  for (const owner of ['issuer', 'pool'] as const) {
    if (!keystore.has(owner)) keystore.setElGamal(owner, xrpl.deriveConfidentialKeypair() as ElGamalKeyPair)
  }
  if (!keystore.getMeta('cmptIssuanceId')) {
    // MPTokenIssuanceID = 4-byte sequence + issuer AccountID, as on the real ledger
    const issuerId = Buffer.from(decodeAccountID(keystore.getWallet('issuer').address)).toString('hex')
    keystore.setMeta('cmptIssuanceId', ('0000' + randomBytes(2).toString('hex') + issuerId).toUpperCase())
  }
  const shop = keystore.getWallet('demoShop').address
  if (!keystore.has({ user: shop })) keystore.createUserElGamal(shop)
  return keystore
}

/** A ready mock world: seeded memory key store + mock ledger. */
export function createMockEnvironment(opts: { validationDelayMs?: number; keystore?: KeyStore; startLedger?: number } = {}): { keystore: KeyStore; ledger: MockLedger } {
  const keystore = seedMockKeyStore(opts.keystore ?? createMemoryKeyStore())
  const ledger = createMockLedger({ keystore, validationDelayMs: opts.validationDelayMs, startLedger: opts.startLedger })
  return { keystore, ledger }
}
