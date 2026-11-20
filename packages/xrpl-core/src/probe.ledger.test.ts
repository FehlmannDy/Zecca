// Devnet regression suite for xrpl-core: privy-xrpl-probe/probe.mjs cases a..k, ported. Users sign through
// mockRawSigner (the raw_sign contract: hash in, compact r||s out, DER + low-S inside); our accounts sign locally.
// Throwaway accounts only, funded from the faucet in beforeAll.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import type { ElGamalKeyPair } from '@zecca/contracts'
import { mockRawSigner, type MockRawSigner } from './signer'
import { buildBatch, spfFee, spfReserve, tfSponsorCreatedAccount } from './batch'
import { buildConvert, buildMergeInbox, buildSend, buildOnboarding, confidentialBalance, type ConfidentialContext } from './confidential'
import { createDevnetSystem, expectOk, localSigner, mptAmount, run, type DevnetSystem } from './test-devnet'

let sys: DevnetSystem
let ctx: ConfidentialContext
let H2: xrpl.Wallet, K: xrpl.Wallet
let UA: MockRawSigner, UB: MockRawSigner
let uaKey: ElGamalKeyPair, h2Key: ElGamalKeyPair
let MPT2: string, MPT3: string
const evidence: Record<string, string> = {}
const ok = (label: string, r: { engineResult: string; hash: string }) => {
  evidence[label] = `${r.engineResult} ${r.hash}`
  expect(r.engineResult, `${label} ${r.hash}`).toBe('tesSUCCESS')
}

beforeAll(async () => {
  H2 = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
  K = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
  UA = mockRawSigner()
  UB = mockRawSigner()
  sys = await createDevnetSystem([H2.classicAddress, K.classicAddress, UA.address])
  ctx = { client: sys.client, keystore: sys.keystore, issuanceId: sys.issuanceId }
  const I = localSigner(sys.wallets.issuer)
  const created = async (flags: number) => String((expectOk('mpt create', await run(sys.client, I, { TransactionType: 'MPTokenIssuanceCreate', Account: sys.wallets.issuer.classicAddress, Flags: flags }))).meta?.mpt_issuance_id)
  MPT2 = await created(32)
  MPT3 = await created(32)
  h2Key = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
  uaKey = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
  const h2 = localSigner(H2)
  expectOk('H2 authorize', await run(sys.client, h2, { TransactionType: 'MPTokenAuthorize', Account: H2.classicAddress, MPTokenIssuanceID: sys.issuanceId }))
  expectOk('H2 key', await run(sys.client, h2, await buildConvert(ctx, { account: H2.classicAddress, amountMinor: 0, holderKey: h2Key })))
})

afterAll(async () => {
  process.stderr.write(`\n[probe a..k evidence] ${JSON.stringify(evidence, null, 1)}\n`)
  await sys?.client.close()
})

describe('probe cases a..k on Devnet (raw_sign contract)', () => {
  it('a. XRP payment baseline', async () => {
    ok('a', await run(sys.client, UA, { TransactionType: 'Payment', Account: UA.address, Destination: H2.classicAddress, Amount: '1000000' }))
  })

  it('b. sponsored account creation: 1 drop, the sponsor holds the reserve', async () => {
    ok('b', await run(sys.client, localSigner(sys.wallets.sponsor), { TransactionType: 'Payment', Account: sys.wallets.sponsor.classicAddress, Destination: UB.address, Amount: '1', Flags: tfSponsorCreatedAccount }))
    const ub = await sys.client.accountInfo(UB.address)
    expect(ub).toMatchObject({ Balance: '1', Sponsor: sys.wallets.sponsor.classicAddress })
  })

  it('c. MPTokenAuthorize on the 1-drop account, fee + reserve sponsored (co-signed)', async () => {
    const P = sys.wallets.sponsor
    ok('c', await run(sys.client, UB, { TransactionType: 'MPTokenAuthorize', Account: UB.address, MPTokenIssuanceID: MPT2 }, { fill: { sponsor: P.classicAddress, reserve: true }, cosign: P }))
  })

  it('d. confidential key registration (authorize + Convert 0)', async () => {
    ok('d.authorize', await run(sys.client, UA, { TransactionType: 'MPTokenAuthorize', Account: UA.address, MPTokenIssuanceID: sys.issuanceId }))
    ok('d.convert0', await run(sys.client, UA, await buildConvert(ctx, { account: UA.address, amountMinor: 0, holderKey: uaKey })))
  })

  it('e. public credit, Convert, MergeInbox, confidential send', async () => {
    ok('e.pay', await run(sys.client, localSigner(sys.wallets.issuer), { TransactionType: 'Payment', Account: sys.wallets.issuer.classicAddress, Destination: UA.address, Amount: mptAmount(sys.issuanceId, 1000) }))
    ok('e.convert', await run(sys.client, UA, await buildConvert(ctx, { account: UA.address, amountMinor: 500, holderKey: uaKey })))
    ok('e.merge', await run(sys.client, UA, await buildMergeInbox(ctx, { account: UA.address, sponsored: false })))
    ok('e.send', await run(sys.client, UA, await buildSend(ctx, { from: UA.address, to: H2.classicAddress, amountMinor: 100, senderKey: uaKey, sponsored: false })))
    expect(await confidentialBalance(ctx, UA.address, uaKey)).toEqual({ spendableMinor: 400, inboxMinor: 0 })
  })

  it('f. the same send, fee paid by the co-signing sponsor', async () => {
    const tx = await buildSend(ctx, { from: UA.address, to: H2.classicAddress, amountMinor: 50, senderKey: uaKey, sponsored: true, publicKey: UA.publicKey })
    expect(tx).toMatchObject({ Sponsor: sys.wallets.sponsor.classicAddress, SponsorFlags: spfFee })
    ok('f', await run(sys.client, UA, tx, { fill: false, cosign: sys.wallets.sponsor }))
  })

  it('g. DelegateSet [ConfidentialMPTSend] to the relayer, then a delegated send signed by the relayer', async () => {
    const R = sys.wallets.relayer
    ok('g.delegate', await run(sys.client, UA, { TransactionType: 'DelegateSet', Account: UA.address, Authorize: R.classicAddress, Permissions: [{ Permission: { PermissionValue: 'ConfidentialMPTSend' } }] }))
    const tx = await buildSend(ctx, { from: UA.address, to: H2.classicAddress, amountMinor: 25, senderKey: uaKey, sponsored: false })
    ok('g.send', await run(sys.client, localSigner(R), { ...tx, Delegate: R.classicAddress }))
  })

  it("h. Batch on the 1-drop account: inner reserve + outer fee sponsored; h'. on a funded account, outer fee only", async () => {
    const P = sys.wallets.sponsor, I = sys.wallets.issuer
    const base = await sys.client.baseFeeDrops()
    const ledger = await sys.client.ledgerIndex()
    const seqB = await sys.client.nextSequence(UB.address)
    const hb = buildBatch({
      outer: { Account: UB.address, Sequence: seqB, LastLedgerSequence: ledger + 20 },
      inners: [
        { TransactionType: 'MPTokenAuthorize', Account: UB.address, Sequence: seqB + 1, MPTokenIssuanceID: MPT3, Sponsor: P.classicAddress, SponsorFlags: spfReserve },
        { TransactionType: 'Payment', Account: I.classicAddress, Sequence: await sys.client.nextSequence(I.classicAddress), Destination: UB.address, Amount: mptAmount(MPT3, 10) },
      ],
      sponsor: P.classicAddress,
      cosigners: [I, P],
      baseFeeDrops: base,
    })
    ok('h', await run(sys.client, UB, hb, { fill: false, cosign: P }))
    const seqA = await sys.client.nextSequence(UA.address)
    const ha = buildBatch({
      outer: { Account: UA.address, Sequence: seqA, LastLedgerSequence: ledger + 20 },
      inners: [
        { TransactionType: 'MPTokenAuthorize', Account: UA.address, Sequence: seqA + 1, MPTokenIssuanceID: MPT3 },
        { TransactionType: 'Payment', Account: I.classicAddress, Sequence: await sys.client.nextSequence(I.classicAddress), Destination: UA.address, Amount: mptAmount(MPT3, 10) },
      ],
      sponsor: P.classicAddress,
      cosigners: [I],
      baseFeeDrops: base,
    })
    ok("h'", await run(sys.client, UA, ha, { fill: false, cosign: P }))
  })

  it('i. MergeInbox signed by the relayer under DelegateSet', async () => {
    const R = sys.wallets.relayer
    ok('i.delegate', await run(sys.client, UA, { TransactionType: 'DelegateSet', Account: UA.address, Authorize: R.classicAddress, Permissions: [{ Permission: { PermissionValue: 'ConfidentialMPTSend' } }, { Permission: { PermissionValue: 'ConfidentialMPTMergeInbox' } }] }))
    ok('i.convert', await run(sys.client, UA, await buildConvert(ctx, { account: UA.address, amountMinor: 100, holderKey: uaKey })))
    const before = await confidentialBalance(ctx, UA.address, uaKey)
    expect(before.inboxMinor).toBe(100)
    ok('i.merge', await run(sys.client, localSigner(R), await buildMergeInbox(ctx, { account: UA.address, sponsored: false, delegate: R.classicAddress })))
    const after = await confidentialBalance(ctx, UA.address, uaKey)
    expect(after).toEqual({ spendableMinor: before.spendableMinor + 100, inboxMinor: 0 })
  })

  it('j. one-signature onboarding on a sponsor-created account: [authorize (reserve sponsored), Convert 0 + key, merge]', async () => {
    const UC = mockRawSigner()
    ok('j.create', await run(sys.client, localSigner(sys.wallets.sponsor), { TransactionType: 'Payment', Account: sys.wallets.sponsor.classicAddress, Destination: UC.address, Amount: '1', Flags: tfSponsorCreatedAccount }))
    const ucKey = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
    const b = await buildOnboarding(ctx, { address: UC.address, publicKey: UC.publicKey, holderKey: ucKey, welcomeCreditMinor: 0 })
    ok('j.batch', await run(sys.client, UC, b, { fill: false, cosign: sys.wallets.sponsor }))
    expect((await sys.client.accountInfo(UC.address))?.Balance).toBe('1')
    expect(await confidentialBalance(ctx, UC.address, ucKey)).toEqual({ spendableMinor: 0, inboxMinor: 0 })
  })

  it('k. CredentialCreate by a KYC issuer, CredentialAccept by the 1-drop account, fee + reserve sponsored', async () => {
    const CRED = Buffer.from('KYC').toString('hex').toUpperCase()
    ok('k.create', await run(sys.client, localSigner(K), { TransactionType: 'CredentialCreate', Account: K.classicAddress, Subject: UB.address, CredentialType: CRED }))
    const P = sys.wallets.sponsor
    ok('k.accept', await run(sys.client, UB, { TransactionType: 'CredentialAccept', Account: UB.address, Issuer: K.classicAddress, CredentialType: CRED }, { fill: { sponsor: P.classicAddress, reserve: true }, cosign: P }))
    expect((await sys.client.accountInfo(UB.address))?.Balance).toBe('1')
  })
})

