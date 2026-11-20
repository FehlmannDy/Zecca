// Confidential MPT (XLS-96) builders. Ported from privy-xrpl-probe web/server.mjs:75/102/123 (prepareOnboarding,
// prepareSend, balance) and card-issuer/src/xrpl-pool.js (bounded decrypt, merge + send). Keys come from a KeyStore.
import xrpl from 'xrpl'
import * as mc from '@xrplf/mpt-crypto'
import { decodeAccountID } from 'ripple-address-codec'
import type { ConfidentialBalance, ElGamalKeyPair, KeyStore, OnboardingParams, SendParams, UnsignedTx } from '@zecca/contracts'
import { buildBatch, spfReserve } from './batch'
import { fillTx, MAX_USER_FEE_DROPS, USER_LLS_WINDOW } from './fill'
import { walletFrom } from './wallet'
import type { XrplClient } from './client'

export type ConfidentialClient = Pick<XrplClient, 'request' | 'ledgerIndex' | 'nextSequence' | 'accountInfo' | 'baseFeeDrops'> & { raw: unknown }
export type ConfidentialContext = { client: ConfidentialClient; keystore: KeyStore; issuanceId: string }

type Tx = Record<string, any>

/** Decryption cost grows with the bound (10k: ~0.2 s, 200k: ~4 s), so escalate (card-issuer xrpl-pool.js). */
export const DECRYPT_BOUNDS = [10_000n, 200_000n, 10_000_000n] as const

export async function decryptBounded(ciphertextHex: string, privateKeyHex: string, bounds: readonly bigint[] = DECRYPT_BOUNDS): Promise<number> {
  for (const hi of bounds) {
    try {
      return Number(await mc.decryptAmount(ciphertextHex, privateKeyHex, hi))
    } catch {
      /* above this bound */
    }
  }
  throw new Error(`could not decrypt amount below ${String(bounds[bounds.length - 1])}`)
}

const accountIdHex = (a: string) => Buffer.from(decodeAccountID(a)).toString('hex').toUpperCase()
const isNotFound = (e: unknown) => ['entryNotFound', 'objectNotFound'].includes(String((e as Tx)?.data?.error))

export async function fetchIssuance(client: ConfidentialClient, issuanceId: string, ledgerIndex: number | 'validated' = 'validated'): Promise<Tx> {
  return (await client.request({ command: 'ledger_entry', mpt_issuance: issuanceId, ledger_index: ledgerIndex })).result.node
}

/** The holder's MPToken entry, or null when the account never authorized the issuance. */
export async function fetchMPToken(client: ConfidentialClient, account: string, issuanceId: string, ledgerIndex: number | 'validated' = 'validated'): Promise<Tx | null> {
  try {
    return (await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: issuanceId, account }, ledger_index: ledgerIndex })).result.node
  } catch (e) {
    if (isNotFound(e)) return null
    throw e
  }
}

function assertAmount(v: number, allowZero: boolean) {
  if (!Number.isSafeInteger(v) || v < (allowZero ? 0 : 1)) throw new Error(`amount must be a ${allowZero ? 'non-negative' : 'positive'} integer in minor units`)
}

/**
 * SPEC §2.4: one user signature. Batch [MPTokenAuthorize (reserve sponsored), issuer Payment of the credit (omitted
 * when 0), ConfidentialMPTConvert of the credit registering the key, ConfidentialMPTMergeInbox, + DelegateSet of
 * ConfidentialMPTMergeInbox to `delegateMergeTo` (reserve sponsored)], outer fee sponsored, BatchSigners set.
 * The account must exist (Ledger.ensureAccount). The Convert context hash binds the explicit inner sequence.
 */
export async function buildOnboarding(ctx: ConfidentialContext, p: OnboardingParams): Promise<UnsignedTx> {
  const { client, keystore, issuanceId } = ctx
  assertAmount(p.welcomeCreditMinor, true)
  const sponsor = walletFrom(keystore.getWallet('sponsor'))
  const issuer = walletFrom(keystore.getWallet('issuer'))
  const credit = p.welcomeCreditMinor
  const acct = await client.accountInfo(p.address)
  if (!acct) throw new Error(`account ${p.address} does not exist: create it first (ensureAccount)`)
  const [seq, ledger, base, issuance, issuerSeq] = await Promise.all([
    client.nextSequence(p.address),
    client.ledgerIndex(),
    client.baseFeeDrops(),
    fetchIssuance(client, issuanceId),
    credit > 0 ? client.nextSequence(issuer.classicAddress) : Promise.resolve(0),
  ])
  if (!issuance.IssuerEncryptionKey) throw new Error(`issuance ${issuanceId} has no IssuerEncryptionKey`)
  const convertSeq = seq + 2
  const bf = await mc.generateBlindingFactor()
  const [hEnc, iEnc, aEnc, ctxHash] = await Promise.all([
    mc.encryptAmount(BigInt(credit), p.holderKey.publicKey, bf),
    mc.encryptAmount(BigInt(credit), issuance.IssuerEncryptionKey, bf),
    issuance.AuditorEncryptionKey ? mc.encryptAmount(BigInt(credit), issuance.AuditorEncryptionKey, bf) : Promise.resolve(undefined),
    mc.getConvertContextHash(accountIdHex(p.address), issuanceId, convertSeq),
  ])
  const proof = await mc.getConvertProof(p.holderKey.publicKey, p.holderKey.privateKey, ctxHash)
  const user = p.address
  const inners: Tx[] = [
    { TransactionType: 'MPTokenAuthorize', Account: user, Sequence: seq + 1, MPTokenIssuanceID: issuanceId, Sponsor: sponsor.classicAddress, SponsorFlags: spfReserve },
  ]
  if (credit > 0) {
    inners.push({ TransactionType: 'Payment', Account: issuer.classicAddress, Sequence: issuerSeq, Destination: user, Amount: { mpt_issuance_id: issuanceId, value: String(credit) } })
  }
  const convert: Tx = {
    TransactionType: 'ConfidentialMPTConvert', Account: user, Sequence: convertSeq, MPTokenIssuanceID: issuanceId, MPTAmount: String(credit),
    HolderEncryptionKey: p.holderKey.publicKey, HolderEncryptedAmount: hEnc, IssuerEncryptedAmount: iEnc, BlindingFactor: bf, ZKProof: proof,
  }
  if (aEnc) convert.AuditorEncryptedAmount = aEnc
  inners.push(convert, { TransactionType: 'ConfidentialMPTMergeInbox', Account: user, Sequence: seq + 3, MPTokenIssuanceID: issuanceId })
  if (p.delegateMergeTo) {
    inners.push({
      TransactionType: 'DelegateSet', Account: user, Sequence: seq + 4, Authorize: p.delegateMergeTo,
      Permissions: [{ Permission: { PermissionValue: 'ConfidentialMPTMergeInbox' } }],
      Sponsor: sponsor.classicAddress, SponsorFlags: spfReserve,
    })
  }
  const batch = buildBatch({
    outer: { Account: user, Sequence: seq, LastLedgerSequence: ledger + USER_LLS_WINDOW, SigningPubKey: p.publicKey },
    inners,
    sponsor: sponsor.classicAddress,
    cosigners: credit > 0 ? [issuer, sponsor] : [sponsor],
    baseFeeDrops: base,
  })
  if (Number(batch.Fee) > MAX_USER_FEE_DROPS) throw new Error(`onboarding fee ${String(batch.Fee)} drops is above the 2 XRP cap`)
  return batch
}

/**
 * ConfidentialMPTSend with its proof. The spending balance is decrypted with a bound just above the balance
 * (xrpl.js would search up to the whole confidential supply), then the proven xrpl.js builder does the rest.
 */
export async function buildSend(ctx: ConfidentialContext, p: SendParams): Promise<UnsignedTx> {
  const { client, keystore, issuanceId } = ctx
  assertAmount(p.amountMinor, false)
  const ledger = await client.ledgerIndex()
  const [issuance, token, destToken, seq] = await Promise.all([
    fetchIssuance(client, issuanceId, ledger),
    fetchMPToken(client, p.from, issuanceId, ledger),
    fetchMPToken(client, p.to, issuanceId, ledger),
    client.nextSequence(p.from),
  ])
  if (!destToken?.HolderEncryptionKey) throw new Error(`recipient ${p.to} has no registered HolderEncryptionKey`)
  const balance = token?.ConfidentialBalanceSpending ? await decryptBounded(token.ConfidentialBalanceSpending, p.senderKey.privateKey) : 0
  if (p.amountMinor > balance) throw new Error('insufficient confidential balance')
  const outstanding = BigInt(issuance.ConfidentialOutstandingAmount ?? 0)
  const tx = await xrpl.prepareConfidentialSend(client.raw as xrpl.Client, {
    account: p.from,
    destination: p.to,
    mptIssuanceID: issuanceId,
    amount: BigInt(p.amountMinor),
    senderKeypair: p.senderKey,
    sequence: seq,
    ledgerIndex: ledger,
    outstandingDelta: BigInt(balance) + 1n - outstanding,
  })
  const sponsor = p.sponsored ? walletFrom(keystore.getWallet('sponsor')).classicAddress : undefined
  return fillTx(client, tx as unknown as Tx, { sponsor, publicKey: p.publicKey })
}

/** ConfidentialMPTMergeInbox. With `delegate`, the relayer submits for `account` (DelegateSet granted at sign-up). */
export async function buildMergeInbox(ctx: ConfidentialContext, p: { account: string; sponsored: boolean; delegate?: string; publicKey?: string }): Promise<UnsignedTx> {
  const { client, keystore, issuanceId } = ctx
  const tx: Tx = { TransactionType: 'ConfidentialMPTMergeInbox', Account: p.account, Sequence: await client.nextSequence(p.account), MPTokenIssuanceID: issuanceId }
  if (p.delegate) tx.Delegate = p.delegate
  const sponsor = p.sponsored ? walletFrom(keystore.getWallet('sponsor')).classicAddress : undefined
  return fillTx(client, tx, { sponsor, publicKey: p.publicKey })
}

/** ConfidentialMPTConvert (public -> confidential inbox). Registers the key when the MPToken has none (amount 0 for a bare registration). */
export async function buildConvert(ctx: ConfidentialContext, p: { account: string; amountMinor: number; holderKey: ElGamalKeyPair }): Promise<UnsignedTx> {
  const { client, issuanceId } = ctx
  assertAmount(p.amountMinor, true)
  const [ledger, seq] = await Promise.all([client.ledgerIndex(), client.nextSequence(p.account)])
  const tx = await xrpl.prepareConfidentialConvert(client.raw as xrpl.Client, {
    account: p.account,
    mptIssuanceID: issuanceId,
    amount: BigInt(p.amountMinor),
    holderKeypair: p.holderKey,
    sequence: seq,
    ledgerIndex: ledger,
  })
  return fillTx(client, tx as unknown as Tx, {})
}

export async function confidentialBalance(ctx: ConfidentialContext, address: string, key: ElGamalKeyPair): Promise<ConfidentialBalance> {
  const token = await fetchMPToken(ctx.client, address, ctx.issuanceId)
  const [spendableMinor, inboxMinor] = await Promise.all([
    token?.ConfidentialBalanceSpending ? decryptBounded(token.ConfidentialBalanceSpending, key.privateKey) : 0,
    token?.ConfidentialBalanceInbox ? decryptBounded(token.ConfidentialBalanceInbox, key.privateKey) : 0,
  ])
  return { spendableMinor, inboxMinor }
}
