import { describe, expect, it } from 'vitest'
import xrpl from 'xrpl'
import * as rk from 'ripple-keypairs'
import * as mc from '@xrplf/mpt-crypto'
import { createMemoryKeyStore } from '@zecca/keystore'
import type { ElGamalKeyPair } from '@zecca/contracts'
import { AlreadyOnboardedError, buildConvert, buildMergeInbox, buildOnboarding, buildSend, confidentialBalance, DECRYPT_BOUNDS, decryptBounded } from './confidential'
import { batchSigningPayload, byAccountId, tfInnerBatchTxn } from './batch'
import { mockRawSigner } from './signer'
import { generateWalletSecret } from './wallet'
import { createTicketAllocator } from './tickets'

const ID = '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9'
type Tx = Record<string, any>
const enc = async (v: number, pub: string) => mc.encryptAmount(BigInt(v), pub, await mc.generateBlindingFactor())
const dec = async (ct: string, k: ElGamalKeyPair) => Number(await mc.decryptAmount(ct, k.privateKey, 100_000n))

// A fake ledger: accounts, MPTokens and the issuance, answered like rippled (ledger_entry / account_info).
function setup(opts: { base?: number } = {}) {
  const keystore = createMemoryKeyStore()
  for (const r of ['sponsor', 'issuer', 'pool', 'relayer'] as const) keystore.setWallet(r, generateWalletSecret())
  const issuerKey = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
  keystore.setElGamal('issuer', issuerKey)
  const seqs: Record<string, number> = {}
  const tokens: Record<string, Tx> = {}
  const issuance: Tx = { IssuerEncryptionKey: issuerKey.publicKey, ConfidentialOutstandingAmount: '900000' }
  const reqs: Tx[] = []
  const issuerTickets: number[] = []
  const request = async (req: Tx): Promise<Tx> => {
    reqs.push(req)
    if (req.command === 'account_objects' && req.type === 'ticket') {
      return { result: { account_objects: (req.account === keystore.getWallet('issuer').address ? issuerTickets : []).map((t) => ({ TicketSequence: t })) } }
    }
    if (req.command === 'ledger_entry' && req.mpt_issuance) return { result: { node: issuance } }
    if (req.command === 'ledger_entry' && req.mptoken) {
      const t = tokens[req.mptoken.account]
      if (!t) throw Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
      return { result: { node: t } }
    }
    if (req.command === 'account_info') {
      if (seqs[req.account] == null) throw Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } })
      return { result: { account_data: { Sequence: seqs[req.account] } } }
    }
    throw new Error('unexpected ' + req.command)
  }
  const client = {
    raw: { request, getLedgerIndex: async () => 1000 },
    request,
    ledgerIndex: async () => 1000,
    nextSequence: async (a: string) => ((await request({ command: 'account_info', account: a })) as Tx).result.account_data.Sequence,
    accountInfo: async (a: string) => (seqs[a] == null ? null : { Sequence: seqs[a] }),
    baseFeeDrops: async () => opts.base ?? 1,
  }
  const addr = (r: 'sponsor' | 'issuer' | 'pool' | 'relayer') => keystore.getWallet(r).address
  seqs[addr('issuer')] = 7
  seqs[addr('pool')] = 50
  const ctx = { client: client as never, keystore, issuanceId: ID }
  return { ctx, keystore, seqs, tokens, issuance, issuerKey, addr, reqs, issuerTickets }
}

describe('decryptBounded', () => {
  it('decrypts within the first bound', async () => {
    const k = xrpl.deriveConfidentialKeypair()
    expect(await decryptBounded(await enc(1234, k.publicKey), k.privateKey)).toBe(1234)
  })
  it('escalates through the bounds and fails above the last one', async () => {
    const k = xrpl.deriveConfidentialKeypair()
    expect(await decryptBounded(await enc(500, k.publicKey), k.privateKey, [100n, 1000n])).toBe(500)
    await expect(decryptBounded(await enc(5000, k.publicKey), k.privateKey, [100n, 1000n])).rejects.toThrow(/could not decrypt/)
  })
  it('caps every bound at max (the confidential supply + 1: no amount can exceed it)', async () => {
    const k = xrpl.deriveConfidentialKeypair()
    const ct = await enc(5000, k.publicKey)
    await expect(decryptBounded(ct, k.privateKey, [10_000n], 4000n)).rejects.toThrow(/could not decrypt/)
    expect(await decryptBounded(ct, k.privateKey, DECRYPT_BOUNDS, 5001n)).toBe(5000)
  })
  it('a wrong key costs one search up to the cap, not the whole escalation', async () => {
    const k = xrpl.deriveConfidentialKeypair()
    const other = xrpl.deriveConfidentialKeypair()
    const t = Date.now()
    await expect(decryptBounded(await enc(5000, k.publicKey), other.privateKey, [10_000n, 400_000n], 5001n)).rejects.toThrow(/could not decrypt/)
    expect(Date.now() - t).toBeLessThan(2000)
  }, 30_000)
  it('does not escalate on malformed input (bad hex, wrong key length)', async () => {
    const k = xrpl.deriveConfidentialKeypair()
    await expect(decryptBounded('ZZ', k.privateKey)).rejects.toThrow(/hex/)
    await expect(decryptBounded(await enc(1, k.publicKey), 'AB')).rejects.toThrow(/privateKey/)
  })
})

describe('buildOnboarding', () => {
  it('builds the 4-inner sign-up Batch with explicit sequences, a Convert of the credit and issuer + sponsor BatchSigners', async () => {
    const { ctx, keystore, seqs, issuerKey, addr } = setup()
    const user = mockRawSigner()
    seqs[user.address] = 100
    keystore.createUserElGamal(user.address)
    const holderKey = keystore.getElGamal({ user: user.address })
    const b = (await buildOnboarding(ctx, { address: user.address, publicKey: user.publicKey, holderKey, welcomeCreditMinor: 5000 })) as Tx
    const inner = b.RawTransactions.map((r: Tx) => r.RawTransaction)
    expect(inner.map((t: Tx) => t.TransactionType)).toEqual(['MPTokenAuthorize', 'Payment', 'ConfidentialMPTConvert', 'ConfidentialMPTMergeInbox'])
    expect(b).toMatchObject({ Account: user.address, Sequence: 100, Sponsor: addr('sponsor'), SponsorFlags: 1, LastLedgerSequence: 1150, SigningPubKey: user.publicKey, Fee: '26' })
    expect(inner.map((t: Tx) => t.Sequence)).toEqual([101, 7, 102, 103])
    expect(inner[0]).toMatchObject({ Sponsor: addr('sponsor'), SponsorFlags: 2, SponsorSignature: { SigningPubKey: '' } })
    expect(inner[1]).toMatchObject({ Account: addr('issuer'), Destination: user.address, Amount: { mpt_issuance_id: ID, value: '5000' } })
    for (const t of inner) expect(t.Flags & tfInnerBatchTxn).toBe(tfInnerBatchTxn)
    const conv = inner[2]
    expect(conv).toMatchObject({ MPTAmount: '5000', HolderEncryptionKey: holderKey.publicKey, MPTokenIssuanceID: ID })
    expect(conv.ZKProof).toMatch(/^[0-9A-F]+$/)
    expect(await dec(conv.HolderEncryptedAmount, holderKey)).toBe(5000)
    expect(await dec(conv.IssuerEncryptedAmount, issuerKey)).toBe(5000)
    // BatchSigners: issuer (inner Payment) and sponsor (inner reserve), sorted, valid
    expect(b.BatchSigners.map((s: Tx) => s.BatchSigner.Account).sort()).toEqual([addr('issuer'), addr('sponsor')].sort())
    expect([...b.BatchSigners].sort(byAccountId)).toEqual(b.BatchSigners)
    for (const { BatchSigner: s } of b.BatchSigners) expect(rk.verify(batchSigningPayload(b, s.Account), s.TxnSignature, s.SigningPubKey)).toBe(true)
    // the user's signer changes nothing (all fields set) and the blob encodes
    const signed = xrpl.decode((await user.sign(b)).tx_blob) as Tx
    expect(signed.Fee).toBe(b.Fee)
    expect(signed.RawTransactions).toEqual(b.RawTransactions)
  })

  it('omits the issuer Payment when the credit is 0 (probe case j): only the sponsor co-signs', async () => {
    const { ctx, keystore, seqs, addr } = setup()
    const user = mockRawSigner()
    seqs[user.address] = 100
    keystore.createUserElGamal(user.address)
    const b = (await buildOnboarding(ctx, { address: user.address, publicKey: user.publicKey, holderKey: keystore.getElGamal({ user: user.address }), welcomeCreditMinor: 0 })) as Tx
    expect(b.RawTransactions.map((r: Tx) => r.RawTransaction.TransactionType)).toEqual(['MPTokenAuthorize', 'ConfidentialMPTConvert', 'ConfidentialMPTMergeInbox'])
    expect(b.RawTransactions[1].RawTransaction.MPTAmount).toBe('0')
    expect(b.BatchSigners.map((s: Tx) => s.BatchSigner.Account)).toEqual([addr('sponsor')])
  })

  it('adds the DelegateSet (ConfidentialMPTMergeInbox to the relayer, reserve sponsored) as a fifth inner', async () => {
    const { ctx, keystore, seqs, addr } = setup()
    const user = mockRawSigner()
    seqs[user.address] = 100
    keystore.createUserElGamal(user.address)
    const b = (await buildOnboarding(ctx, { address: user.address, publicKey: user.publicKey, holderKey: keystore.getElGamal({ user: user.address }), welcomeCreditMinor: 5000, delegateMergeTo: addr('relayer') })) as Tx
    const last = b.RawTransactions[4].RawTransaction
    expect(last).toMatchObject({
      TransactionType: 'DelegateSet', Account: user.address, Sequence: 104, Authorize: addr('relayer'),
      Permissions: [{ Permission: { PermissionValue: 'ConfidentialMPTMergeInbox' } }],
      Sponsor: addr('sponsor'), SponsorFlags: 2, SponsorSignature: { SigningPubKey: '' },
    })
    expect(() => xrpl.encode(b as never)).not.toThrow()
  })

  it('with issuer tickets, the welcome-credit Payment uses a ticket (Sequence 0): two sign-ups prepared together do not share an issuer sequence', async () => {
    const { ctx, keystore, seqs, addr, issuerTickets } = setup()
    issuerTickets.push(41, 40)
    const tctx = { ...ctx, tickets: createTicketAllocator(ctx.client) }
    const users = [mockRawSigner(), mockRawSigner()]
    for (const u of users) {
      seqs[u.address] = 100
      keystore.createUserElGamal(u.address)
    }
    const built = (await Promise.all(
      users.map((u) => buildOnboarding(tctx, { address: u.address, publicKey: u.publicKey, holderKey: keystore.getElGamal({ user: u.address }), welcomeCreditMinor: 5000 })),
    )) as Tx[]
    const pays = built.map((b) => b.RawTransactions[1].RawTransaction)
    expect(pays.map((p: Tx) => `${p.Account === addr('issuer')} ${p.Sequence} ${p.TicketSequence}`).sort()).toEqual(['true 0 40', 'true 0 41'])
    for (const b of built) {
      for (const { BatchSigner: s } of b.BatchSigners) expect(rk.verify(batchSigningPayload(b, s.Account), s.TxnSignature, s.SigningPubKey)).toBe(true)
      expect(() => xrpl.encode(b as never)).not.toThrow()
    }
  })

  it('with no free issuer ticket it falls back to the issuer sequence; a credit of 0 takes no ticket', async () => {
    const { ctx, keystore, seqs, reqs } = setup()
    const tctx = { ...ctx, tickets: createTicketAllocator(ctx.client) }
    const user = mockRawSigner()
    seqs[user.address] = 100
    keystore.createUserElGamal(user.address)
    const p = { address: user.address, publicKey: user.publicKey, holderKey: keystore.getElGamal({ user: user.address }) }
    const b = (await buildOnboarding(tctx, { ...p, welcomeCreditMinor: 5000 })) as Tx
    expect(b.RawTransactions[1].RawTransaction).toMatchObject({ TransactionType: 'Payment', Sequence: 7 })
    expect(b.RawTransactions[1].RawTransaction.TicketSequence).toBeUndefined()
    reqs.length = 0
    await buildOnboarding(tctx, { ...p, welcomeCreditMinor: 0 })
    expect(reqs.some((r) => r.command === 'account_objects')).toBe(false)
  })

  it('refuses an account that already holds the token: ALREADY_ONBOARDED when the key is this one (a retry Batch would fail on MPTokenAuthorize)', async () => {
    const { ctx, keystore, seqs, tokens } = setup()
    const user = mockRawSigner()
    seqs[user.address] = 100
    keystore.createUserElGamal(user.address)
    const holderKey = keystore.getElGamal({ user: user.address })
    const p = { address: user.address, publicKey: user.publicKey, holderKey, welcomeCreditMinor: 5000 }
    tokens[user.address] = { HolderEncryptionKey: holderKey.publicKey.toUpperCase() }
    const err = await buildOnboarding(ctx, p).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AlreadyOnboardedError)
    expect(err).toMatchObject({ code: 'ALREADY_ONBOARDED', address: user.address })
    tokens[user.address] = { HolderEncryptionKey: xrpl.deriveConfidentialKeypair().publicKey }
    await expect(buildOnboarding(ctx, p)).rejects.toThrow(/another encryption key/)
    tokens[user.address] = {}
    await expect(buildOnboarding(ctx, p)).rejects.toThrow(/without an encryption key/)
  })

  it('refuses an account that does not exist yet', async () => {
    const { ctx, keystore } = setup()
    const user = mockRawSigner()
    keystore.createUserElGamal(user.address)
    await expect(buildOnboarding(ctx, { address: user.address, publicKey: user.publicKey, holderKey: keystore.getElGamal({ user: user.address }), welcomeCreditMinor: 1 })).rejects.toThrow(/does not exist/)
  })
})

describe('buildSend', () => {
  it('a sponsored user send to the pool: proof built against the spending balance, every field filled', async () => {
    const { ctx, keystore, seqs, tokens, addr } = setup()
    const user = mockRawSigner()
    seqs[user.address] = 9
    keystore.createUserElGamal(user.address)
    const k = keystore.getElGamal({ user: user.address })
    const poolKey = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
    tokens[user.address] = { HolderEncryptionKey: k.publicKey, ConfidentialBalanceSpending: await enc(5000, k.publicKey), ConfidentialBalanceVersion: 2 }
    tokens[addr('pool')] = { HolderEncryptionKey: poolKey.publicKey }
    const tx = (await buildSend(ctx, { from: user.address, to: addr('pool'), amountMinor: 1200, senderKey: k, sponsored: true, publicKey: user.publicKey })) as Tx
    expect(tx).toMatchObject({ TransactionType: 'ConfidentialMPTSend', Account: user.address, Destination: addr('pool'), Sequence: 9, Fee: '10', LastLedgerSequence: 1150, Sponsor: addr('sponsor'), SponsorFlags: 1, SigningPubKey: user.publicKey })
    expect(await dec(tx.DestinationEncryptedAmount, poolKey)).toBe(1200)
    expect(tx.ZKProof).toMatch(/^[0-9A-F]+$/)
  }, 20_000)

  it('a pool payout is not sponsored and uses the short window', async () => {
    const { ctx, keystore, tokens, addr } = setup()
    const poolKey = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
    keystore.setElGamal('pool', poolKey)
    const dest = xrpl.deriveConfidentialKeypair()
    tokens[addr('pool')] = { HolderEncryptionKey: poolKey.publicKey, ConfidentialBalanceSpending: await enc(3000, poolKey.publicKey), ConfidentialBalanceVersion: 1 }
    const to = mockRawSigner().address
    tokens[to] = { HolderEncryptionKey: dest.publicKey }
    const tx = (await buildSend(ctx, { from: addr('pool'), to, amountMinor: 995, senderKey: poolKey, sponsored: false })) as Tx
    expect(tx).toMatchObject({ Sequence: 50, LastLedgerSequence: 1020 })
    expect(tx.Sponsor).toBeUndefined()
  }, 20_000)

  it('refuses a send above the spendable balance, a zero amount, and a recipient without a key', async () => {
    const { ctx, keystore, seqs, tokens, addr } = setup()
    const user = mockRawSigner()
    seqs[user.address] = 9
    keystore.createUserElGamal(user.address)
    const k = keystore.getElGamal({ user: user.address })
    tokens[user.address] = { HolderEncryptionKey: k.publicKey, ConfidentialBalanceSpending: await enc(100, k.publicKey) }
    tokens[addr('pool')] = { HolderEncryptionKey: xrpl.deriveConfidentialKeypair().publicKey }
    tokens.rNoKey = {}
    const p = { from: user.address, to: addr('pool'), senderKey: k, sponsored: true }
    await expect(buildSend(ctx, { ...p, amountMinor: 101 })).rejects.toThrow(/insufficient/i)
    await expect(buildSend(ctx, { ...p, amountMinor: 0 })).rejects.toThrow(/positive integer/)
    await expect(buildSend(ctx, { ...p, to: 'rNoKey', amountMinor: 1 })).rejects.toThrow(/HolderEncryptionKey/)
  })

  it('refuses a sender key that is not the one registered on the ledger', async () => {
    const { ctx, keystore, seqs, tokens, addr } = setup()
    const user = mockRawSigner()
    seqs[user.address] = 9
    keystore.createUserElGamal(user.address)
    const k = keystore.getElGamal({ user: user.address })
    tokens[user.address] = { HolderEncryptionKey: xrpl.deriveConfidentialKeypair().publicKey, ConfidentialBalanceSpending: await enc(100, k.publicKey) }
    tokens[addr('pool')] = { HolderEncryptionKey: xrpl.deriveConfidentialKeypair().publicKey }
    await expect(buildSend(ctx, { from: user.address, to: addr('pool'), senderKey: k, sponsored: true, amountMinor: 10 })).rejects.toThrow(/does not match/)
  }, 20_000)
})

describe('buildMergeInbox and buildConvert', () => {
  it('a sponsored user merge, and the delegated form for the relayer (Account = user, Delegate = relayer)', async () => {
    const { ctx, seqs, addr } = setup()
    seqs.rUser = 4
    const m = (await buildMergeInbox(ctx, { account: 'rUser', sponsored: true, publicKey: '02AB' })) as Tx
    expect(m).toMatchObject({ TransactionType: 'ConfidentialMPTMergeInbox', Account: 'rUser', Sequence: 4, MPTokenIssuanceID: ID, Sponsor: addr('sponsor'), SponsorFlags: 1, LastLedgerSequence: 1150, SigningPubKey: '02AB', Fee: '10' })
    const d = (await buildMergeInbox(ctx, { account: 'rUser', sponsored: false, delegate: addr('relayer') })) as Tx
    expect(d).toMatchObject({ Account: 'rUser', Delegate: addr('relayer'), Sequence: 4, LastLedgerSequence: 1020 })
    expect(d.Sponsor).toBeUndefined()
  })

  it('a Convert of 0 registers the key; a Convert of an amount on a registered key does not re-register', async () => {
    const { ctx, tokens, addr, issuerKey } = setup()
    const k = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
    tokens[addr('pool')] = {}
    const reg = (await buildConvert(ctx, { account: addr('pool'), amountMinor: 0, holderKey: k })) as Tx
    expect(reg).toMatchObject({ TransactionType: 'ConfidentialMPTConvert', MPTAmount: '0', HolderEncryptionKey: k.publicKey, Sequence: 50, Fee: '10' })
    expect(reg.ZKProof).toBeTruthy()
    tokens[addr('pool')] = { HolderEncryptionKey: k.publicKey }
    const c = (await buildConvert(ctx, { account: addr('pool'), amountMinor: 4000, holderKey: k })) as Tx
    expect(c.HolderEncryptionKey).toBeUndefined()
    expect(await dec(c.IssuerEncryptedAmount, issuerKey)).toBe(4000)
  })
})

describe('confidentialBalance', () => {
  it('decrypts spending and inbox; an account without the token has 0', async () => {
    const { ctx, tokens } = setup()
    const k = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
    tokens.rA = { ConfidentialBalanceSpending: await enc(700, k.publicKey), ConfidentialBalanceInbox: await enc(45, k.publicKey) }
    expect(await confidentialBalance(ctx, 'rA', k)).toEqual({ spendableMinor: 700, inboxMinor: 45 })
    expect(await confidentialBalance(ctx, 'rNone', k)).toEqual({ spendableMinor: 0, inboxMinor: 0 })
  })
  it('bounds the search by the issuance confidential supply (read at the same ledger as the token)', async () => {
    const { ctx, tokens, issuance } = setup()
    const k = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
    // Impossible on a real ledger (a balance above the supply): shows the supply caps the search.
    issuance.ConfidentialOutstandingAmount = '1000'
    tokens.rA = { HolderEncryptionKey: k.publicKey, ConfidentialBalanceSpending: await enc(5000, k.publicKey) }
    await expect(confidentialBalance(ctx, 'rA', k)).rejects.toThrow(/could not decrypt/)
  })
  it('refuses a key that is not the one registered on the ledger, before any decrypt', async () => {
    const { ctx, tokens } = setup()
    const k = xrpl.deriveConfidentialKeypair() as ElGamalKeyPair
    tokens.rA = { HolderEncryptionKey: xrpl.deriveConfidentialKeypair().publicKey, ConfidentialBalanceSpending: await enc(5, k.publicKey) }
    await expect(confidentialBalance(ctx, 'rA', k)).rejects.toThrow(/does not match/)
  })
})
