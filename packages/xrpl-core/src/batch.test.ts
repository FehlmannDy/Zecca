import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import * as rk from 'ripple-keypairs'
import { decode } from 'ripple-binary-codec'
import { batchFeeDrops, batchSigner, batchSigningPayload, buildBatch, byAccountId, requiredBatchSigners, tfAllOrNothing, tfInnerBatchTxn, spfFee, spfReserve } from './batch'
import fixtures from './fixtures/validated-devnet.json'

type Tx = Record<string, any>
const BATCHES = ['onboardingBrowser', 'batchCaseH_UB', 'batchCaseH_UA', 'batchCaseJ'] as const
const fx = (k: (typeof BATCHES)[number]) => decode(fixtures[k].tx_blob) as Tx
const inner = (b: Tx) => b.RawTransactions.map((r: Tx) => r.RawTransaction)

describe('batch helpers against the Batches that validated on Devnet', () => {
  it('BatchSigners are sorted by AccountID bytes (byAccountId)', () => {
    for (const k of BATCHES) {
      const b = fx(k)
      const sorted = [...b.BatchSigners].sort(byAccountId)
      expect(sorted.map((s: Tx) => s.BatchSigner.Account)).toEqual(b.BatchSigners.map((s: Tx) => s.BatchSigner.Account))
    }
  })

  it('our BatchSigner payload reproduces every validated BatchSigner signature', () => {
    for (const k of BATCHES) {
      const b = fx(k)
      for (const { BatchSigner: s } of b.BatchSigners) {
        expect(rk.verify(batchSigningPayload(b, s.Account), s.TxnSignature, s.SigningPubKey)).toBe(true)
      }
    }
  })

  it('required signers = every other inner account and every inner sponsor, outer account excluded', () => {
    for (const k of BATCHES) {
      const b = fx(k)
      expect([...requiredBatchSigners(b)].sort()).toEqual(b.BatchSigners.map((s: Tx) => s.BatchSigner.Account).sort())
    }
  })

  it('batchFeeDrops reproduces the validated outer Fee (base fee 1 drop on Devnet)', () => {
    for (const k of BATCHES) {
      const b = fx(k)
      expect(batchFeeDrops(1, inner(b), b.BatchSigners.length)).toBe(Number(b.Fee))
    }
    // base 10: 2*10 + inner(10 + 10 + 100 + 100) + 2 signers * 10
    expect(batchFeeDrops(10, inner(fx('onboardingBrowser')), 2)).toBe(260)
  })
})

describe('buildBatch', () => {
  const user = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
  const issuer = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
  const sponsor = xrpl.Wallet.generate(xrpl.ECDSA.secp256k1)
  const ID = '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9'

  const onboardingInners = (seq: number) => [
    { TransactionType: 'MPTokenAuthorize', Account: user.classicAddress, Sequence: seq + 1, MPTokenIssuanceID: ID, Sponsor: sponsor.classicAddress, SponsorFlags: spfReserve },
    { TransactionType: 'Payment', Account: issuer.classicAddress, Sequence: 77, Destination: user.classicAddress, Amount: { mpt_issuance_id: ID, value: '100' } },
    { TransactionType: 'ConfidentialMPTMergeInbox', Account: user.classicAddress, Sequence: seq + 2, MPTokenIssuanceID: ID },
  ]

  // Role-mapped structure of a Batch, to compare ours with the validated one.
  const shape = (b: Tx) => {
    const role = (a: string) => (a === b.Account ? 'outer' : a === b.Sponsor ? 'sponsor' : 'other')
    return {
      Flags: b.Flags,
      SponsorFlags: b.SponsorFlags,
      inners: inner(b).map((t: Tx) => ({
        TransactionType: t.TransactionType,
        Flags: t.Flags,
        Fee: t.Fee,
        SigningPubKey: t.SigningPubKey,
        account: role(t.Account),
        sponsor: t.Sponsor ? role(t.Sponsor) : undefined,
        SponsorFlags: t.SponsorFlags,
        SponsorSignature: t.SponsorSignature,
      })),
      signers: b.BatchSigners.map((s: Tx) => role(s.BatchSigner.Account)),
    }
  }

  it('applies every Batch gotcha and matches the validated onboarding structure', () => {
    const seq = 1000
    const b = buildBatch({ outer: { Account: user.classicAddress, Sequence: seq, LastLedgerSequence: 500 }, inners: onboardingInners(seq), sponsor: sponsor.classicAddress, cosigners: [issuer, sponsor], baseFeeDrops: 1 })
    expect(b.TransactionType).toBe('Batch')
    expect(b.Flags).toBe(tfAllOrNothing)
    expect(b).toMatchObject({ Sponsor: sponsor.classicAddress, SponsorFlags: spfFee, Sequence: seq, LastLedgerSequence: 500 })
    for (const t of inner(b)) {
      expect(t.Flags & tfInnerBatchTxn).toBe(tfInnerBatchTxn)
      expect(t.Fee).toBe('0')
      expect(t.SigningPubKey).toBe('')
      expect(t.TxnSignature).toBeUndefined()
    }
    expect(inner(b)[0].SponsorSignature).toEqual({ SigningPubKey: '' })
    expect(inner(b)[1].SponsorSignature).toBeUndefined()
    expect(b.Fee).toBe(String(batchFeeDrops(1, inner(b), 2)))
    // signer order by AccountID bytes, each signature verifies
    const signers = b.BatchSigners as any[]
    expect([...signers].sort(byAccountId)).toEqual(signers)
    for (const { BatchSigner: s } of signers) expect(rk.verify(batchSigningPayload(b, s.Account), s.TxnSignature, s.SigningPubKey)).toBe(true)
    // the validated onboarding had Convert too; compare the shared inner types position by position
    const ours = shape(b)
    const ref = shape(fx('onboardingBrowser'))
    expect(ours.Flags).toBe(ref.Flags)
    expect(ours.SponsorFlags).toBe(ref.SponsorFlags)
    expect(ours.inners[0]).toEqual(ref.inners[0])
    expect(ours.inners[1]).toEqual(ref.inners[1])
    expect(ours.inners[2]).toEqual(ref.inners[3])
    expect([...ours.signers].sort()).toEqual([...ref.signers].sort())
    // it encodes
    expect(() => xrpl.encode(b as never)).not.toThrow()
  })

  it('matches case j (only the inner reserve sponsor signs) and case h-prime (only the issuer signs)', () => {
    const j = buildBatch({
      outer: { Account: user.classicAddress, Sequence: 10 },
      inners: [{ TransactionType: 'MPTokenAuthorize', Account: user.classicAddress, Sequence: 11, MPTokenIssuanceID: ID, Sponsor: sponsor.classicAddress, SponsorFlags: spfReserve }],
      sponsor: sponsor.classicAddress,
      cosigners: [sponsor],
    })
    expect(shape(j).signers).toEqual(shape(fx('batchCaseJ')).signers)
    const h = buildBatch({
      outer: { Account: user.classicAddress, Sequence: 10 },
      inners: [
        { TransactionType: 'MPTokenAuthorize', Account: user.classicAddress, Sequence: 11, MPTokenIssuanceID: ID },
        { TransactionType: 'Payment', Account: issuer.classicAddress, Sequence: 3, Destination: user.classicAddress, Amount: { mpt_issuance_id: ID, value: '10' } },
      ],
      sponsor: sponsor.classicAddress,
      cosigners: [issuer],
      baseFeeDrops: 1,
    })
    expect(shape(h)).toEqual(shape(fx('batchCaseH_UA')))
    expect(h.Fee).toBe(fx('batchCaseH_UA').Fee)
  })

  it('does not mutate its inputs', () => {
    const inners = onboardingInners(5)
    const before = JSON.stringify(inners)
    buildBatch({ outer: { Account: user.classicAddress, Sequence: 5 }, inners, sponsor: sponsor.classicAddress, cosigners: [issuer, sponsor] })
    expect(JSON.stringify(inners)).toBe(before)
  })

  it('refuses inners without explicit sequences, with a fee, or already signed', () => {
    const base = { outer: { Account: user.classicAddress, Sequence: 5 }, sponsor: sponsor.classicAddress, cosigners: [] as xrpl.Wallet[] }
    expect(() => buildBatch({ ...base, inners: [{ TransactionType: 'ConfidentialMPTMergeInbox', Account: user.classicAddress, MPTokenIssuanceID: ID }] })).toThrow(/explicit Sequence/)
    expect(() => buildBatch({ ...base, inners: [{ TransactionType: 'ConfidentialMPTMergeInbox', Account: user.classicAddress, Sequence: 6, Fee: '10', MPTokenIssuanceID: ID }] })).toThrow(/Fee/)
    expect(() => buildBatch({ ...base, inners: [{ TransactionType: 'ConfidentialMPTMergeInbox', Account: user.classicAddress, Sequence: 6, TxnSignature: 'AB', MPTokenIssuanceID: ID }] })).toThrow(/signed/)
    expect(() => buildBatch({ ...base, inners: [] })).toThrow(/at least one/)
  })

  it('refuses a missing or an extra cosigner', () => {
    const p = { outer: { Account: user.classicAddress, Sequence: 1000 }, inners: onboardingInners(1000), sponsor: sponsor.classicAddress }
    expect(() => buildBatch({ ...p, cosigners: [issuer] })).toThrow(/missing BatchSigner/)
    expect(() => buildBatch({ ...p, cosigners: [issuer, sponsor, user] })).toThrow(/not needed/)
  })

  it('batchSigner returns the BatchSigner object for one wallet', () => {
    const b = buildBatch({ outer: { Account: user.classicAddress, Sequence: 1000 }, inners: onboardingInners(1000), sponsor: sponsor.classicAddress, cosigners: [issuer, sponsor] })
    const s = batchSigner(issuer, b)
    expect(s.BatchSigner.Account).toBe(issuer.classicAddress)
    expect(rk.verify(batchSigningPayload(b, issuer.classicAddress), s.BatchSigner.TxnSignature, issuer.publicKey)).toBe(true)
  })
})
