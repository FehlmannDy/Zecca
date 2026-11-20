// createLiveLedger on Devnet, on a throwaway system: sign-up with welcome credit, sponsored deposit to the pool,
// pool payout, and SPEC §2.5 "to verify": DelegateSet (ConfidentialMPTMergeInbox -> relayer) as a fifth inner tx
// of the sign-up Batch on a 1-drop account, then a delegated MergeInbox submitted by the relayer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mockRawSigner, type MockRawSigner } from './signer'
import { createLiveLedger, type LiveLedger } from './ledger'
import { createDevnetSystem, type DevnetSystem } from './test-devnet'
import type { LedgerTxEvent } from '@zecca/contracts'

let sys: DevnetSystem
let ledger: LiveLedger
let U1: MockRawSigner, U2: MockRawSigner
const evidence: Record<string, string> = {}
const record = (label: string, r: { engineResult: string; hash: string }) => (evidence[label] = `${r.engineResult} ${r.hash}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function signUp(user: MockRawSigner, credit: number, delegate: boolean) {
  const created = await ledger.ensureAccount(user.address)
  expect(created.created).toBe(true)
  sys.keystore.createUserElGamal(user.address)
  const tx = await ledger.buildOnboarding({
    address: user.address,
    publicKey: user.publicKey,
    holderKey: sys.keystore.getElGamal({ user: user.address }),
    welcomeCreditMinor: credit,
    delegateMergeTo: delegate ? sys.wallets.relayer.classicAddress : undefined,
  })
  return ledger.submitUserSigned((await user.sign(tx)).tx_blob)
}

beforeAll(async () => {
  sys = await createDevnetSystem()
  await sys.client.close()
  ledger = createLiveLedger({ network: 'devnet', keystore: sys.keystore })
  U1 = mockRawSigner()
  U2 = mockRawSigner()
})

afterAll(async () => {
  process.stderr.write(`\n[live ledger evidence] ${JSON.stringify(evidence, null, 1)}\n`)
  await ledger?.close()
})

describe('createLiveLedger on Devnet', () => {
  it('onboards a fresh user with a welcome credit of 5000 in one signature; the balance shows it', async () => {
    const r = await signUp(U1, 5000, false)
    record('signup U1', r)
    expect(r.engineResult).toBe('tesSUCCESS')
    expect(r.validated).toBe(true)
    expect(await ledger.confidentialBalance(U1.address, sys.keystore.getElGamal({ user: U1.address }))).toEqual({ spendableMinor: 5000, inboxMinor: 0 })
    expect((await ledger.client.accountInfo(U1.address))?.Balance).toBe('1')
  })

  it('SPEC §2.5: DelegateSet as the fifth inner of the sign-up Batch on a 1-drop account with sponsored reserve', async () => {
    const r = await signUp(U2, 5000, true)
    record('signup U2 + DelegateSet inner', r)
    expect(r.engineResult).toBe('tesSUCCESS')
    const delegate = await ledger.client.request({ command: 'account_objects', account: U2.address, type: 'delegate', ledger_index: 'validated' })
    const objs = delegate.result.account_objects as Record<string, any>[]
    expect(objs).toHaveLength(1)
    expect(objs[0]).toMatchObject({ Authorize: sys.wallets.relayer.classicAddress, Permissions: [{ Permission: { PermissionValue: 'ConfidentialMPTMergeInbox' } }] })
    expect((await ledger.client.accountInfo(U2.address))?.Balance).toBe('1')
  })

  it('a sponsored send user -> pool: the watcher sees it and the pool key decrypts the amount', async () => {
    const pool = sys.wallets.pool.classicAddress
    const seen: LedgerTxEvent[] = []
    const stop = ledger.watchAccount(pool, (e) => seen.push(e))
    await sleep(500)
    const tx = await ledger.buildSend({ from: U1.address, to: pool, amountMinor: 1200, senderKey: sys.keystore.getElGamal({ user: U1.address }), sponsored: true, publicKey: U1.publicKey })
    const signed = await U1.sign(tx)
    expect(signed.tx_blob).toBeTruthy()
    const r = await ledger.submitUserSigned(signed.tx_blob)
    record('send U1 -> pool 1200', r)
    expect(r.engineResult).toBe('tesSUCCESS')
    expect(r.hash).not.toBe(signed.hash)
    const ev = await ledger.txByHash(r.hash)
    expect(ev).toMatchObject({ validated: true, engineResult: 'tesSUCCESS' })
    expect(await ledger.decryptAmount(String(ev!.tx.DestinationEncryptedAmount), sys.poolKey.privateKey)).toBe(1200)
    for (let i = 0; i < 20 && !seen.some((e) => e.hash === r.hash); i++) await sleep(500)
    stop()
    expect(seen.map((e) => e.hash)).toContain(r.hash)
    expect((await ledger.accountTx(pool, 5)).map((e) => e.hash)).toContain(r.hash)
    expect(await ledger.confidentialBalance(U1.address, sys.keystore.getElGamal({ user: U1.address }))).toEqual({ spendableMinor: 3800, inboxMinor: 0 })
  })

  it('the pool merges its inbox and pays out to a second user (lands in their inbox)', async () => {
    const pool = sys.wallets.pool.classicAddress
    const m = await ledger.submitAs('pool', await ledger.buildMergeInbox({ account: pool, sponsored: false }))
    record('pool merge', m)
    expect(m.engineResult).toBe('tesSUCCESS')
    expect(await ledger.confidentialBalance(pool, sys.poolKey)).toEqual({ spendableMinor: 1200, inboxMinor: 0 })
    const pay = await ledger.submitAs('pool', await ledger.buildSend({ from: pool, to: U2.address, amountMinor: 995, senderKey: sys.poolKey, sponsored: false }))
    record('pool payout 995 -> U2', pay)
    expect(pay.engineResult).toBe('tesSUCCESS')
    expect(await ledger.confidentialBalance(U2.address, sys.keystore.getElGamal({ user: U2.address }))).toEqual({ spendableMinor: 5000, inboxMinor: 995 })
    expect(await ledger.confidentialBalance(pool, sys.poolKey)).toEqual({ spendableMinor: 205, inboxMinor: 0 })
  })

  it('the relayer merges that user inbox under the delegation granted at sign-up', async () => {
    const relayer = sys.wallets.relayer.classicAddress
    const r = await ledger.submitAs('relayer', await ledger.buildMergeInbox({ account: U2.address, sponsored: false, delegate: relayer }))
    record('relayer delegated merge U2', r)
    expect(r.engineResult).toBe('tesSUCCESS')
    expect(await ledger.confidentialBalance(U2.address, sys.keystore.getElGamal({ user: U2.address }))).toEqual({ spendableMinor: 5995, inboxMinor: 0 })
    expect((await ledger.client.accountInfo(U2.address))?.Balance).toBe('1')
  })

  it('a sign-up whose reserved issuer sequence was used meanwhile is reported failed (outer validates, inners do not); preparing again works', async () => {
    const U3 = mockRawSigner()
    await ledger.ensureAccount(U3.address)
    sys.keystore.createUserElGamal(U3.address)
    const key = sys.keystore.getElGamal({ user: U3.address })
    const p = { address: U3.address, publicKey: U3.publicKey, holderKey: key, welcomeCreditMinor: 100 }
    const stale = await ledger.buildOnboarding(p)
    const issuer = sys.wallets.issuer.classicAddress
    expect((await ledger.submitAs('issuer', { TransactionType: 'AccountSet', Account: issuer })).engineResult).toBe('tesSUCCESS')
    const r = await ledger.submitUserSigned((await U3.sign(stale)).tx_blob)
    record('signup U3 with a stale issuer sequence', r)
    expect(r).toMatchObject({ validated: false, engineResult: 'tecBATCH_INNER_FAILED' })
    expect(await ledger.confidentialBalance(U3.address, key)).toEqual({ spendableMinor: 0, inboxMinor: 0 })
    const again = await ledger.submitUserSigned((await U3.sign(await ledger.buildOnboarding(p))).tx_blob)
    record('signup U3 prepared again', again)
    expect(again.engineResult).toBe('tesSUCCESS')
    expect(await ledger.confidentialBalance(U3.address, key)).toEqual({ spendableMinor: 100, inboxMinor: 0 })
  })

  it('a delegated merge for a user who granted nothing is refused', async () => {
    const r = await ledger.submitAs('relayer', await ledger.buildMergeInbox({ account: U1.address, sponsored: false, delegate: sys.wallets.relayer.classicAddress }))
    record('relayer merge U1 (no delegation)', r)
    expect(r.validated).toBe(false)
    expect(r.engineResult).toBe('terNO_DELEGATE_PERMISSION')
  })
})
