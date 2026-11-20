// The two outside systems Earn drives, as interfaces: the XRPL Testnet (treasury and the users' custodial wallets) and
// Flare Coston2 (smart accounts, Firelight). Live implementations in live-testnet.ts / live-flare.ts; in-memory ones in
// mock-sides.ts (EARN_MODE=mock and the unit tests).
import type { Hex } from 'viem'

export type TxOutcome = { validated: boolean; engineResult: string; hash: string }
export type Signed = { hash: string; blob: string }

export type PaymentSpec = { Destination: string; Amount: string; Memos?: { Memo: { MemoData: string } }[] }

export interface TestnetSide {
  readonly mode: 'live' | 'mock'
  treasuryAddress(): string
  /** The user's custodial Testnet wallet (SPEC §4.7 fallback), created on first use and held in the key store. */
  walletFor(userAddress: string): string
  /** XRP balance in drops; 0 when the account does not exist yet. */
  balanceDrops(address: string): Promise<bigint>
  /** Base reserve in drops. */
  reserveDrops(): Promise<bigint>
  /** Signs a Payment (autofilled) from the treasury or from a user's wallet. Nothing is sent yet. */
  sign(from: 'treasury' | { user: string }, p: PaymentSpec): Promise<Signed>
  /** Submits a signed blob and waits for validation. Submitting the same blob twice is harmless (same sequence). */
  submit(blob: string): Promise<TxOutcome>
  /** Outcome of a tx by hash, null when the ledger does not know it. */
  txResult(hash: string): Promise<{ validated: boolean; engineResult: string } | null>
  /** Asks the faucet for XRP when the treasury holds less than `minDrops`. */
  topUpTreasury(minDrops: bigint): Promise<void>
}

export type MintParams = { coreVault: string; feeBips: bigint; minFeeUBA: bigint; execFeeUBA: bigint; fxrp: Hex; assetManager: Hex; vault: Hex }
export type VaultPosition = { shares: bigint; assets: bigint; fxrp: bigint }

export interface FlareSide {
  readonly mode: 'live' | 'mock'
  /** CREATE2 address of the smart account for an XRPL address (known before it exists). */
  personalAccount(xrplAddress: string): Promise<Hex>
  nonce(personalAccount: Hex): Promise<bigint>
  mintParams(): Promise<MintParams>
  /**
   * eth_call of MasterAccountController.handleMintedFAssets as the AssetManager with amount 0 (ff.mjs). 'ok' or the error
   * name; 'CallFailed' is expected for a deposit (no FXRP in a simulation) and means the decode and the nonce passed.
   */
  simulate(memoHex: Hex, xrplAddress: string): Promise<string>
  /** True once Flare executed the payment (MAC.isTransactionIdUsed(0x + lowercase hash)). Failures stay false forever. */
  isExecuted(xrplHash: string): Promise<boolean>
  /** Firelight shares and assets (FXRP UBA = drops) and the loose FXRP of the account, from MAC.getBalances. */
  position(xrplAddress: string): Promise<VaultPosition>
  currentPeriod(): Promise<bigint>
  /** Unix seconds when the period after the current one ends (a request now becomes claimable then). */
  nextPeriodEnd(): Promise<bigint>
  /** Assets owed to the account for a withdrawal period, and whether it was claimed. */
  withdrawal(period: bigint, personalAccount: Hex): Promise<{ assets: bigint; claimed: boolean }>
}
