// Component interfaces shared across packages. Types only (no runtime code).
import type { MetalSymbol, Network } from './index'

// ---------- keys ----------
export type WalletRole =
  | 'sponsor'
  | 'issuer'
  | 'pool'
  | 'relayer'
  | 'cardSettlement'
  | 'kycIssuer'
  | 'testnetTreasury'
  | 'marketIssuer'
  | 'oracle'
  | 'demoShop'

/** A wallet's secret as stored. Turn it into an xrpl.Wallet with xrpl-core's `walletFrom`. Never log it. */
export type WalletSecret = { address: string; seed: string; algorithm: 'ecdsa-secp256k1' | 'ed25519' }

/** ElGamal keypair for confidential MPT (hex strings, as returned by xrpl.deriveConfidentialKeypair). */
export type ElGamalKeyPair = { publicKey: string; privateKey: string }
export type ElGamalPublicKey = string
export type ElGamalOwner = 'issuer' | 'pool' | { user: string }

export interface KeyStore {
  getWallet(role: WalletRole): WalletSecret
  hasWallet(role: WalletRole): boolean
  setWallet(role: WalletRole, secret: WalletSecret): void
  getElGamal(owner: ElGamalOwner): ElGamalKeyPair
  setElGamal(owner: ElGamalOwner, keyPair: ElGamalKeyPair): void
  /** Creates and stores the user's ElGamal key. Idempotent: returns the existing public key if present. */
  createUserElGamal(address: string): ElGamalPublicKey
  has(owner: ElGamalOwner): boolean
  /** Non-secret ledger ids, e.g. 'cmptIssuanceId', 'metal:XAU'. */
  getMeta(key: string): string | undefined
  setMeta(key: string, value: string): void
}

// ---------- signing ----------
/** Same contract for Privy (raw_sign), the mock and local keys: hash in, 64-byte r||s out; DER + low-S + verify inside. */
export interface UserSigner {
  address: string
  publicKey: string
  sign(tx: Record<string, unknown>): Promise<{ tx_blob: string; hash: string }>
}

/** Signs a 32-byte hash (0x-prefixed hex) and returns a compact r||s signature (hex, 64 or 65 bytes). Privy raw_sign's contract. */
export type RawSign = (hash0x: string) => Promise<string>

// ---------- ledger ----------
export type UnsignedTx = Record<string, unknown> & { TransactionType: string; Account: string }

export type SubmitResult = {
  validated: boolean
  /** tesSUCCESS on success. */
  engineResult: string
  /** Ledger hash (differs from the hash at signing once the sponsor co-signs). */
  hash: string
  ledgerIndex?: number
  meta?: Record<string, unknown>
}

export type LedgerTxEvent = {
  hash: string
  ledgerIndex: number
  validated: boolean
  engineResult: string
  tx: Record<string, unknown>
  meta?: Record<string, unknown>
  closeTime?: string
}

export type ConfidentialBalance = { spendableMinor: number; inboxMinor: number }

export type OnboardingParams = {
  address: string
  publicKey: string
  holderKey: ElGamalKeyPair
  /** 0 omits the issuer Payment (probe case j). */
  welcomeCreditMinor: number
  /** When set, the Batch also grants this account the ConfidentialMPTMergeInbox permission (DelegateSet, reserve sponsored). SPEC §2.5. */
  delegateMergeTo?: string
}

export type SendParams = {
  from: string
  to: string
  amountMinor: number
  senderKey: ElGamalKeyPair
  /** User sends: fee sponsored and LastLedgerSequence = current + 150. Pool sends: false. */
  sponsored: boolean
  /** User's public key, set as SigningPubKey so the signing hash is known at prepare time. */
  publicKey?: string
}

/**
 * Everything that touches a ledger. Implemented by xrpl-core (devnet/testnet, live) and ledger-mock (in memory, same state machine).
 * Builders return fully filled unsigned tx JSON (Sequence, Fee, LastLedgerSequence, Sponsor fields) so a user signer changes nothing.
 * submitAs serialises per account (proofs are bound to the sequence and the balance version).
 */
export interface Ledger {
  readonly network: Network
  readonly mode: 'mock' | 'live'
  /** CMPT issuance id (the confidential dollar token). */
  readonly issuanceId: string

  ledgerIndex(): Promise<number>
  accountExists(address: string): Promise<boolean>
  /** Sponsor creates the account with 1 drop and tfSponsorCreatedAccount if it does not exist. */
  ensureAccount(address: string): Promise<{ created: boolean; hash?: string }>

  /** The one-signature sign-up Batch (SPEC §2.4), BatchSigners from issuer and sponsor already set. */
  buildOnboarding(p: OnboardingParams): Promise<UnsignedTx>
  /** ConfidentialMPTSend with proof. */
  buildSend(p: SendParams): Promise<UnsignedTx>
  /** ConfidentialMPTMergeInbox. `delegate`: the relayer submits on behalf of `account` (DelegateSet granted at sign-up). */
  buildMergeInbox(p: { account: string; sponsored: boolean; delegate?: string; publicKey?: string }): Promise<UnsignedTx>
  /** ConfidentialMPTConvert (public -> confidential). amountMinor 0 registers the key. */
  buildConvert(p: { account: string; amountMinor: number; holderKey: ElGamalKeyPair }): Promise<UnsignedTx>
  /** Any user transaction the sponsor pays for: sets Sponsor, SponsorFlags (fee, + reserve when asked), Sequence, Fee, LastLedgerSequence. */
  prepareSponsored(tx: UnsignedTx, opts?: { reserve?: boolean; publicKey?: string }): Promise<UnsignedTx>

  /** Sponsor co-signs a user-signed blob (only if it names our sponsor) then submits and waits for validation. */
  submitUserSigned(txBlob: string): Promise<SubmitResult>
  /** Autofill, sign with one of our own wallets, submit, wait. Serialised per account. */
  submitAs(role: WalletRole, tx: UnsignedTx): Promise<SubmitResult>

  confidentialBalance(address: string, key: ElGamalKeyPair): Promise<ConfidentialBalance>
  /** Bounded search, escalating 10 000 -> 200 000 -> 10 000 000 units. */
  decryptAmount(ciphertextHex: string, privateKeyHex: string): Promise<number>
  /** MPT (public) balance of an issuance, in its smallest unit. */
  mptBalance(address: string, issuanceId: string): Promise<number>

  /** Validated transactions affecting the account. Returns an unsubscribe function. */
  watchAccount(address: string, onTx: (e: LedgerTxEvent) => void): () => void
  accountTx(address: string, limit?: number): Promise<LedgerTxEvent[]>
  txByHash(hash: string): Promise<LedgerTxEvent | null>
  close(): Promise<void>
}

// ---------- pool worker ----------
export type PoolEvent =
  | { type: 'received'; intentId: string; txHash: string; from: string; amountMinor: number }
  | { type: 'paidOut'; intentId: string; txHash: string; to: string; amountMinor: number }
  | { type: 'failed'; intentId: string; stage: 'deposit' | 'payout' | 'merge'; code: string; message: string; txHash?: string }

export interface PoolWorker {
  start(): Promise<void>
  /** The API knows the deposit hash the moment it submits it; matching is exact, by hash. */
  expectDeposit(i: { intentId: string; txHash: string; from: string; amountMinor: number }): void
  on(event: 'received' | 'paidOut' | 'failed', cb: (e: PoolEvent) => void): void
  /** Sent once per intent (persisted sequence, checked on restart). */
  payout(i: { intentId: string; to: string; amountMinor: number }): Promise<{ hash: string }>
  /** SPEC §2.7: issuer pays CMPT to the pool, the pool converts it to confidential. `reference` = the Testnet delivery hash. */
  mintIn(amountMinor: number, reference: string): Promise<{ hash: string }>
  /** SPEC §2.5: the relayer merges the user's inbox. */
  mergeInboxFor(address: string): Promise<{ hash: string }>
  status(): { spendableMinor: number; inboxMinor: number; queue: number }
  stop(): Promise<void>
}

// ---------- market ----------
export interface PriceFeed {
  /** Price per gram in minor units, with its timestamp and source. */
  price(symbol: MetalSymbol): Promise<{ priceMinor: number; at: string; source: string }>
  history(symbol: MetalSymbol, points: number): Promise<number[]>
}
