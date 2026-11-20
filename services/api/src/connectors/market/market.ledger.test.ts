// Market on Devnet, on a throwaway system (never the shared accounts): SPEC §4.9's two "to verify" items and the
// metal mechanics the connector relies on.
//  1. Prices on the ledger: OracleSet from the oracle account, read back (validated tx and the Oracle object).
//  2. Metals: three MPT issuances, a 1-drop user opens a holding with a sponsored reserve, the market issuer pays
//     the metal, the user pays it back to the issuer with a sponsored fee (the sell path).
//  3. One Batch with the MPTokenAuthorize and the confidential deposit to the pool, signed once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import type { ElGamalKeyPair } from '@zecca/contracts'
import { buildBatch, createLiveLedger, decryptBounded, fetchIssuance, fetchMPToken, generateWalletSecret, spfReserve, type LiveLedger } from '@zecca/xrpl-core'
import { mockRawSigner, type MockRawSigner } from '@zecca/xrpl-core/signer'
import { createDevnetSystem, type DevnetSystem } from '../../../../../packages/xrpl-core/src/test-devnet'
import { createFixtureFeed } from './feed'
import { ensureMetalIssuances, metalIssuanceId } from './metals'
import { ORACLE_DOCUMENT_ID, createOracleFeed, readOracleSet } from './oracle'

let sys: DevnetSystem
let ledger: LiveLedger
const evidence: Record<string, string> = {}
const record = (label: string, r: { engineResult: string; hash: string }) => (evidence[label] = `${r.engineResult} ${r.hash}`)
const mpt = (id: string, v: number) => ({ mpt_issuance_id: id, value: String(v) })

beforeAll(async () => {
  const market = generateWalletSecret()
  const oracle = generateWalletSecret()
  sys = await createDevnetSystem([market.address, oracle.address])
  sys.keystore.setWallet('marketIssuer', market)
  sys.keystore.setWallet('oracle', oracle)
  await sys.client.close()
  ledger = createLiveLedger({ network: 'devnet', keystore: sys.keystore })
})

afterAll(async () => {
  process.stderr.write(`\n[market ledger evidence] ${JSON.stringify(evidence, null, 1)}\n`)
  await ledger?.close()
})

async function signUp(u: MockRawSigner, credit: number) {
  await ledger.ensureAccount(u.address)
  sys.keystore.createUserElGamal(u.address)
  const tx = await ledger.buildOnboarding({ address: u.address, publicKey: u.publicKey, holderKey: sys.keystore.getElGamal({ user: u.address }), welcomeCreditMinor: credit })
  const r = await ledger.submitUserSigned((await u.sign(tx)).tx_blob)
  expect(r.engineResult, 'sign-up').toBe('tesSUCCESS')
}

describe('market on Devnet', () => {
  it('to verify: publishes the three prices with OracleSet and reads them back', async () => {
    const feed = createOracleFeed({ inner: createFixtureFeed(), ledger, oracleAddress: sys.keystore.getWallet('oracle').address })
    const p = await feed.publish()
    evidence.oracleSet = p.hash
    expect(p.prices).toEqual({ XAU: 11378, XAG: 132, XPD: 2871 })
    const node = (await ledger.client.request({ command: 'ledger_entry', oracle: { account: sys.keystore.getWallet('oracle').address, oracle_document_id: ORACLE_DOCUMENT_ID }, ledger_index: 'validated' })).result.node
    expect(readOracleSet(node)).toEqual({ XAU: 11378, XAG: 132, XPD: 2871 })
    expect((await feed.price('XAU')).source).toMatch(/XRPL oracle/)
    // an update of the same document
    const moved = createOracleFeed({
      inner: { price: async (s) => ({ ...(await createFixtureFeed().price(s)), priceMinor: s === 'XAU' ? 11400 : (await createFixtureFeed().price(s)).priceMinor }), history: async () => [] },
      ledger,
      oracleAddress: sys.keystore.getWallet('oracle').address,
    })
    await new Promise((r) => setTimeout(r, 1100))
    const q = await moved.publish()
    evidence.oracleUpdate = q.hash
    expect(q.prices.XAU).toBe(11400)
  })

  it('creates the metals, delivers one to a 1-drop user (reserve sponsored) and takes part of it back (fee sponsored)', async () => {
    const created = await ensureMetalIssuances(ledger, sys.keystore)
    expect(created).toEqual(['XAU', 'XAG', 'XPD'])
    const xau = metalIssuanceId(sys.keystore, 'XAU')!
    const node = await fetchIssuance(ledger.client, xau)
    expect(node.Issuer).toBe(sys.keystore.getWallet('marketIssuer').address)
    expect(node.AssetScale ?? 0).toBe(0)

    const u = mockRawSigner()
    await ledger.ensureAccount(u.address)
    const auth = await ledger.prepareSponsored({ TransactionType: 'MPTokenAuthorize', Account: u.address, MPTokenIssuanceID: xau }, { reserve: true, publicKey: u.publicKey })
    expect(record('authorize (reserve sponsored)', await ledger.submitUserSigned((await u.sign(auth)).tx_blob)).split(' ')[0]).toBe('tesSUCCESS')
    const issuer = sys.keystore.getWallet('marketIssuer').address
    const d = await ledger.submitAs('marketIssuer', { TransactionType: 'Payment', Account: issuer, Destination: u.address, Amount: mpt(xau, 1500) })
    expect(record('delivery', d).split(' ')[0]).toBe('tesSUCCESS')
    expect(await ledger.mptBalance(u.address, xau)).toBe(1500)
    const sell = await ledger.prepareSponsored({ TransactionType: 'Payment', Account: u.address, Destination: issuer, Amount: mpt(xau, 500) }, { publicKey: u.publicKey })
    expect(record('sell (fee sponsored)', await ledger.submitUserSigned((await u.sign(sell)).tx_blob)).split(' ')[0]).toBe('tesSUCCESS')
    expect(await ledger.mptBalance(u.address, xau)).toBe(1000)
  })

  it('to verify: one Batch with the MPTokenAuthorize and the confidential deposit to the pool, signed once', async () => {
    const xag = metalIssuanceId(sys.keystore, 'XAG')!
    const u = mockRawSigner()
    await signUp(u, 100)
    const key: ElGamalKeyPair = sys.keystore.getElGamal({ user: u.address })
    const pool = sys.wallets.pool.classicAddress
    const before = await ledger.confidentialBalance(pool, sys.poolKey)

    const c = ledger.client
    const [seq, li, base] = await Promise.all([c.nextSequence(u.address), c.ledgerIndex(), c.baseFeeDrops()])
    const [issuance, token] = await Promise.all([fetchIssuance(c, sys.issuanceId, li), fetchMPToken(c, u.address, sys.issuanceId, li)])
    const balance = await decryptBounded(token!.ConfidentialBalanceSpending, key.privateKey)
    const send = (await xrpl.prepareConfidentialSend(c.raw, {
      account: u.address,
      destination: pool,
      mptIssuanceID: sys.issuanceId,
      amount: 25n,
      senderKeypair: key,
      sequence: seq + 2,
      ledgerIndex: li,
      outstandingDelta: BigInt(balance) + 1n - BigInt(issuance.ConfidentialOutstandingAmount ?? 0),
    })) as unknown as Record<string, unknown>
    for (const k of ['Fee', 'LastLedgerSequence', 'SigningPubKey', 'TxnSignature', 'Sponsor', 'SponsorFlags']) delete send[k]
    send.Sequence = seq + 2
    const sponsor = xrpl.Wallet.fromSeed(sys.keystore.getWallet('sponsor').seed)
    const batch = buildBatch({
      outer: { Account: u.address, Sequence: seq, LastLedgerSequence: li + 150, SigningPubKey: u.publicKey },
      inners: [{ TransactionType: 'MPTokenAuthorize', Account: u.address, Sequence: seq + 1, MPTokenIssuanceID: xag, Sponsor: sponsor.classicAddress, SponsorFlags: spfReserve }, send],
      sponsor: sponsor.classicAddress,
      cosigners: [sponsor],
      baseFeeDrops: base,
    })
    const r = await ledger.submitUserSigned((await u.sign(batch)).tx_blob)
    record('batch authorize + deposit', r)
    expect(r.engineResult).toBe('tesSUCCESS')
    expect(await fetchMPToken(c, u.address, xag)).not.toBeNull()
    const after = await ledger.confidentialBalance(pool, sys.poolKey)
    expect(after.inboxMinor + after.spendableMinor - before.inboxMinor - before.spendableMinor).toBe(25)
  })
})
