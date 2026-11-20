import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import xrpl from 'xrpl'
import * as rk from 'ripple-keypairs'
import { decode, encodeForSigningSponsor } from 'ripple-binary-codec'
import { createMemoryKeyStore } from '@zecca/keystore'
import { createClient, type RawClient } from './client'
import { createLiveLedger } from './ledger'
import { mockRawSigner } from './signer'
import { generateWalletSecret, walletFrom } from './wallet'
import { tfSponsorCreatedAccount } from './batch'
import * as mc from '@xrplf/mpt-crypto'

const ID = '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9'
type Tx = Record<string, any>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A tiny rippled: accounts with sequences; every submitted blob validates (tesSUCCESS) and bumps the sequence.
function fakeRippled() {
  const ee = new EventEmitter()
  const seqs: Record<string, number> = {}
  const submitted: Tx[] = []
  const txs: Record<string, Tx> = {}
  const requests: Tx[] = []
  const issuance: Tx = { ConfidentialOutstandingAmount: '900000' }
  let connected = false
  const raw: RawClient & { emit(e: string, ...a: any[]): void } = {
    async request(req: Tx) {
      if (!connected) throw new Error('NotConnectedError')
      requests.push(req)
      switch (req.command) {
        case 'ledger':
          return { result: { ledger_index: 1000 } }
        case 'server_info':
          return { result: { info: { validated_ledger: { base_fee_xrp: 0.000001 }, load_factor: 1 } } }
        case 'account_info':
          if (seqs[req.account] == null) throw Object.assign(new Error('actNotFound'), { data: { error: 'actNotFound' } })
          return { result: { account_data: { Account: req.account, Sequence: seqs[req.account] } } }
        case 'submit': {
          await sleep(3)
          const tx = decode(req.tx_blob) as Tx
          submitted.push(tx)
          if (tx.Sequence !== seqs[tx.Account] && seqs[tx.Account] != null) return { result: { engine_result: 'tefPAST_SEQ' } }
          if (seqs[tx.Account] != null) seqs[tx.Account]++
          if (tx.TransactionType === 'Payment' && seqs[tx.Destination] == null) seqs[tx.Destination] = 1
          const hash = xrpl.hashes.hashSignedTx(req.tx_blob)
          txs[hash] = { tx_json: tx, hash, meta: { TransactionResult: 'tesSUCCESS' }, ledger_index: 1001, validated: true, close_time_iso: '2026-11-20T20:00:00Z' }
          return { result: { engine_result: 'tesSUCCESS' } }
        }
        case 'tx':
          if (!txs[req.transaction]) throw Object.assign(new Error('txnNotFound'), { data: { error: 'txnNotFound' } })
          return { result: txs[req.transaction] }
        case 'account_tx':
          return { result: { transactions: Object.values(txs).filter((t) => JSON.stringify(t).includes(req.account)).reverse() } }
        case 'ledger_entry':
          if (req.mpt_issuance) return { result: { node: issuance } }
          throw Object.assign(new Error('entryNotFound'), { data: { error: 'entryNotFound' } })
        case 'subscribe':
        case 'unsubscribe':
          return { result: {} }
        default:
          throw new Error('unexpected ' + req.command)
      }
    },
    async connect() {
      connected = true
      ee.emit('connected')
    },
    async disconnect() {
      connected = false
    },
    isConnected: () => connected,
    on: (e: string, cb: (...a: any[]) => void) => ee.on(e, cb),
    removeListener: (e: string, cb: (...a: any[]) => void) => ee.removeListener(e, cb),
    emit: (e: string, ...a: any[]) => ee.emit(e, ...a),
    autofill: async (tx: any) => tx,
  }
  return { raw, seqs, submitted, txs, requests, issuance }
}

function setup() {
  const keystore = createMemoryKeyStore()
  for (const r of ['sponsor', 'issuer', 'pool', 'relayer'] as const) keystore.setWallet(r, generateWalletSecret())
  keystore.setMeta('cmptIssuanceId', ID)
  const rip = fakeRippled()
  for (const r of ['sponsor', 'issuer', 'pool', 'relayer'] as const) rip.seqs[keystore.getWallet(r).address] = 10
  const client = createClient('devnet', { raw: rip.raw, pollMs: 0 })
  const ledger = createLiveLedger({ network: 'devnet', keystore, client })
  return { keystore, rip, ledger, addr: (r: 'sponsor' | 'issuer' | 'pool' | 'relayer') => keystore.getWallet(r).address }
}

describe('createLiveLedger', () => {
  it('is live, names its network and reads the issuance id from the key store', () => {
    const { ledger } = setup()
    expect(ledger).toMatchObject({ mode: 'live', network: 'devnet', issuanceId: ID })
  })

  it('refuses to start without an issuance id', () => {
    const keystore = createMemoryKeyStore()
    expect(() => createLiveLedger({ network: 'devnet', keystore, client: createClient('devnet', { raw: fakeRippled().raw }) })).toThrow(/issuance/)
  })

  it('implements every Ledger method', () => {
    const { ledger } = setup()
    for (const m of ['ledgerIndex', 'accountExists', 'ensureAccount', 'buildOnboarding', 'buildSend', 'buildMergeInbox', 'buildConvert', 'prepareSponsored', 'submitUserSigned', 'submitAs', 'confidentialBalance', 'decryptAmount', 'mptBalance', 'watchAccount', 'accountTx', 'txByHash', 'close'])
      expect(typeof (ledger as unknown as Tx)[m]).toBe('function')
  })
})

describe('accounts', () => {
  it('ensureAccount: the sponsor creates a missing account with 1 drop and tfSponsorCreatedAccount, once', async () => {
    const { ledger, rip, addr } = setup()
    const u = mockRawSigner()
    expect(await ledger.accountExists(u.address)).toBe(false)
    const r = await ledger.ensureAccount(u.address)
    expect(r.created).toBe(true)
    expect(r.hash).toMatch(/^[0-9A-F]{64}$/)
    expect(rip.submitted[0]).toMatchObject({ TransactionType: 'Payment', Account: addr('sponsor'), Destination: u.address, Amount: '1', Flags: tfSponsorCreatedAccount })
    expect(await ledger.ensureAccount(u.address)).toEqual({ created: false })
    expect(rip.submitted).toHaveLength(1)
  })
})

describe('submitting', () => {
  it('submitUserSigned co-signs as the sponsor and returns the ledger hash', async () => {
    const { ledger, rip, addr } = setup()
    const u = mockRawSigner()
    rip.seqs[u.address] = 3
    const tx = await ledger.prepareSponsored({ TransactionType: 'AccountSet', Account: u.address }, { publicKey: u.publicKey })
    expect(tx).toMatchObject({ Sponsor: addr('sponsor'), SponsorFlags: 1, Sequence: 3, LastLedgerSequence: 1150, SigningPubKey: u.publicKey, Fee: '1' })
    const signed = await u.sign(tx)
    const res = await ledger.submitUserSigned(signed.tx_blob)
    expect(res).toMatchObject({ validated: true, engineResult: 'tesSUCCESS' })
    expect(res.hash).not.toBe(signed.hash)
    const sent = rip.submitted[0]
    expect(rk.verify(encodeForSigningSponsor(sent as never), sent.SponsorSignature.TxnSignature, sent.SponsorSignature.SigningPubKey)).toBe(true)
  })

  it('prepareSponsored with reserve sets both sponsor flags', async () => {
    const { ledger, rip } = setup()
    const u = mockRawSigner()
    rip.seqs[u.address] = 3
    expect((await ledger.prepareSponsored({ TransactionType: 'CredentialAccept', Account: u.address }, { reserve: true })).SponsorFlags).toBe(3)
  })

  it('submitUserSigned refuses a blob sponsored by someone else, before anything is sent', async () => {
    const { ledger, rip, addr } = setup()
    const u = mockRawSigner()
    const signed = await u.sign({ TransactionType: 'AccountSet', Account: u.address, Fee: '1', Sequence: 1, LastLedgerSequence: 1100, Sponsor: addr('pool'), SponsorFlags: 1 })
    await expect(ledger.submitUserSigned(signed.tx_blob)).rejects.toThrow(/not sponsored by this backend/)
    expect(rip.submitted).toHaveLength(0)
  })

  it('submitAs fills a missing Sequence inside the per-account queue, so concurrent callers do not collide', async () => {
    const { ledger, rip, addr } = setup()
    const tx = { TransactionType: 'AccountSet', Account: addr('pool') }
    const results = await Promise.all([1, 2, 3].map(() => ledger.submitAs('pool', tx)))
    expect(results.map((r) => r.engineResult)).toEqual(['tesSUCCESS', 'tesSUCCESS', 'tesSUCCESS'])
    expect(rip.submitted.map((t) => t.Sequence)).toEqual([10, 11, 12])
    expect(rip.submitted[0]).toMatchObject({ Fee: '1', LastLedgerSequence: 1020 })
  })

  it('submitAs signs a delegated tx as the delegate (Account = user, Delegate = relayer)', async () => {
    const { ledger, rip, addr, keystore } = setup()
    const u = mockRawSigner()
    rip.seqs[u.address] = 6
    const r = await ledger.submitAs('relayer', { TransactionType: 'ConfidentialMPTMergeInbox', Account: u.address, Delegate: addr('relayer'), MPTokenIssuanceID: ID })
    expect(r.engineResult).toBe('tesSUCCESS')
    const sent = rip.submitted[0]
    expect(sent).toMatchObject({ Account: u.address, Delegate: addr('relayer'), Sequence: 6, Fee: '10' })
    expect(sent.SigningPubKey).toBe(walletFrom(keystore.getWallet('relayer')).publicKey)
  })

  it('submitAs refuses a tx the role cannot sign', async () => {
    const { ledger, addr } = setup()
    await expect(ledger.submitAs('pool', { TransactionType: 'AccountSet', Account: addr('issuer') })).rejects.toThrow(/cannot sign/)
  })
})

describe('reading the ledger', () => {
  it('txByHash and accountTx map to LedgerTxEvent; an unknown hash is null', async () => {
    const { ledger, addr } = setup()
    const r = await ledger.submitAs('pool', { TransactionType: 'AccountSet', Account: addr('pool') })
    const ev = await ledger.txByHash(r.hash)
    expect(ev).toMatchObject({ hash: r.hash, ledgerIndex: 1001, validated: true, engineResult: 'tesSUCCESS', closeTime: '2026-11-20T20:00:00Z' })
    expect(ev?.tx.TransactionType).toBe('AccountSet')
    expect(await ledger.txByHash('00'.repeat(32))).toBeNull()
    expect((await ledger.accountTx(addr('pool'), 5)).map((e) => e.hash)).toEqual([r.hash])
  })

  it('decryptAmount caps the search at the confidential supply on the ledger (+1)', async () => {
    const { ledger, rip } = setup()
    const k = xrpl.deriveConfidentialKeypair()
    const ct = await mc.encryptAmount(5000n, k.publicKey, await mc.generateBlindingFactor())
    expect(await ledger.decryptAmount(ct, k.privateKey)).toBe(5000)
    rip.issuance.ConfidentialOutstandingAmount = '4000'
    await expect(ledger.decryptAmount(ct, k.privateKey)).rejects.toThrow(/could not decrypt amount below 4001/)
  })

  it('watchAccount delivers validated txs of that account once, re-subscribes on reconnect, and unsubscribes', async () => {
    const { ledger, rip, addr } = setup()
    await ledger.ledgerIndex() // connect
    const seen: string[] = []
    const stop = ledger.watchAccount(addr('pool'), (e) => seen.push(e.hash))
    await sleep(1)
    const ev = (hash: string, tx: Tx, validated = true) => rip.raw.emit('transaction', { hash, tx_json: tx, meta: { TransactionResult: 'tesSUCCESS' }, ledger_index: 5, validated })
    ev('A'.repeat(64), { TransactionType: 'ConfidentialMPTSend', Account: 'rX', Destination: addr('pool') })
    ev('A'.repeat(64), { TransactionType: 'ConfidentialMPTSend', Account: 'rX', Destination: addr('pool') })
    ev('B'.repeat(64), { TransactionType: 'Payment', Account: 'rY', Destination: 'rZ' })
    ev('C'.repeat(64), { TransactionType: 'Payment', Account: addr('pool'), Destination: 'rZ' }, false)
    expect(seen).toEqual(['A'.repeat(64)])
    const subs = () => rip.requests.filter((q) => q.command === 'subscribe').length
    expect(subs()).toBe(1)
    rip.raw.emit('connected')
    await sleep(1)
    expect(subs()).toBe(2)
    stop()
    await sleep(1)
    expect(rip.requests.some((q) => q.command === 'unsubscribe' && q.accounts[0] === addr('pool'))).toBe(true)
    ev('D'.repeat(64), { TransactionType: 'Payment', Account: addr('pool'), Destination: 'rZ' })
    expect(seen).toEqual(['A'.repeat(64)])
  })
})

