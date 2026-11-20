// Ledger-test helper (not exported from the package): a throwaway Devnet system, funded from the faucet.
// Never touches the long-lived shared Devnet accounts.
import xrpl from 'xrpl'
import { createMemoryKeyStore } from '@zecca/keystore'
import type { ElGamalKeyPair, KeyStore, SubmitResult, UnsignedTx } from '@zecca/contracts'
import { createClient, type XrplClient } from './client'
import { fund, waitForAccount } from './faucet'
import { fillTx, type FillOptions } from './fill'
import { cosignAsSponsor } from './sponsor'
import { generateWalletSecret, walletFrom } from './wallet'
import { buildConvert } from './confidential'

export type Signer = { address: string; sign(tx: Record<string, unknown>): Promise<{ tx_blob: string; hash: string }> }

export const localSigner = (w: xrpl.Wallet): Signer => ({ address: w.classicAddress, sign: async (tx) => w.sign(tx as never) })

export async function fundAll(client: XrplClient, addresses: string[]) {
  for (const a of addresses) await fund(a, client.network)
  await Promise.all(addresses.map((a) => waitForAccount(client, a)))
}

/** Fill, sign, optionally co-sign as sponsor, submit, wait. */
export async function run(client: XrplClient, signer: Signer, tx: Record<string, unknown>, o: { cosign?: xrpl.Wallet; fill?: FillOptions | false } = {}): Promise<SubmitResult> {
  const filled = o.fill === false ? tx : await fillTx(client, tx, o.fill ?? {})
  let blob = (await signer.sign(filled)).tx_blob
  if (o.cosign) blob = cosignAsSponsor(o.cosign, blob).tx_blob
  return client.submitAndWait(blob)
}

export function expectOk(label: string, r: SubmitResult): SubmitResult {
  if (r.engineResult !== 'tesSUCCESS') throw new Error(`${label}: ${r.engineResult} ${r.hash}`)
  return r
}

export type DevnetSystem = {
  client: XrplClient
  keystore: KeyStore
  issuanceId: string
  wallets: Record<'sponsor' | 'issuer' | 'pool' | 'relayer', xrpl.Wallet>
  issuerKey: ElGamalKeyPair
  poolKey: ElGamalKeyPair
}

/** Fresh sponsor, issuer, pool and relayer; CMPT issuance (Flags 32|128) with issuer key; pool key registered (Convert 0). */
export async function createDevnetSystem(extra: string[] = []): Promise<DevnetSystem> {
  const client = createClient('devnet')
  const keystore = createMemoryKeyStore()
  const roles = ['sponsor', 'issuer', 'pool', 'relayer'] as const
  for (const r of roles) keystore.setWallet(r, generateWalletSecret())
  const wallets = Object.fromEntries(roles.map((r) => [r, walletFrom(keystore.getWallet(r))])) as DevnetSystem['wallets']
  await fundAll(client, [...roles.map((r) => wallets[r].classicAddress), ...extra])
  const I = localSigner(wallets.issuer)
  const create = expectOk('issuance create', await run(client, I, { TransactionType: 'MPTokenIssuanceCreate', Account: wallets.issuer.classicAddress, Flags: 32 | 128, MaximumAmount: '1000000000' }))
  const issuanceId = String((create.meta as Record<string, unknown>)?.mpt_issuance_id)
  const issuerKey = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
  const poolKey = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
  keystore.setElGamal('issuer', issuerKey)
  keystore.setElGamal('pool', poolKey)
  keystore.setMeta('cmptIssuanceId', issuanceId)
  expectOk('issuer key', await run(client, I, { TransactionType: 'MPTokenIssuanceSet', Account: wallets.issuer.classicAddress, MPTokenIssuanceID: issuanceId, IssuerEncryptionKey: issuerKey.publicKey }))
  const P = localSigner(wallets.pool)
  expectOk('pool authorize', await run(client, P, { TransactionType: 'MPTokenAuthorize', Account: wallets.pool.classicAddress, MPTokenIssuanceID: issuanceId }))
  const ctx = { client, keystore, issuanceId }
  expectOk('pool key', await run(client, P, await buildConvert(ctx, { account: wallets.pool.classicAddress, amountMinor: 0, holderKey: poolKey })))
  return { client, keystore, issuanceId, wallets, issuerKey, poolKey }
}

export const mptAmount = (id: string, v: number | string) => ({ mpt_issuance_id: id, value: String(v) })
export type { UnsignedTx }
