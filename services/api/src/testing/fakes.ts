// In-test fakes: a Ledger that builds encodable transactions and checks user signatures like a node, and a PoolWorker that
// answers expectDeposit / payout on a tick. The integration test uses the real @zecca/ledger-mock and @zecca/pool-worker instead.
import xrpl from 'xrpl'
import * as rk from 'ripple-keypairs'
import { decode, encodeForSigning } from 'ripple-binary-codec'
import type {
  ConfidentialBalance,
  ElGamalKeyPair,
  KeyStore,
  Ledger,
  LedgerTxEvent,
  PoolEvent,
  PoolWorker,
  SubmitResult,
  UnsignedTx,
  WalletRole,
} from '@zecca/contracts'
import { createMemoryKeyStore } from '@zecca/keystore'
import { sha512Half } from '@zecca/xrpl-core/signer'

export const FAKE_CMPT = '006C6AA175853178147D8F0D592D9DE3658C836F69985AB9'
const ROLES: WalletRole[] = ['sponsor', 'issuer', 'pool', 'relayer', 'demoShop']

/** A memory key store with generated wallets for the roles the API uses, and trivial ElGamal keys (no crypto needed by the fakes). */
export function fakeKeyStore(): KeyStore {
  let n = 0
  const ks = createMemoryKeyStore({
    generateElGamal: () => {
      n++
      const h = n.toString(16).padStart(64, '0').toUpperCase()
      return { publicKey: '02' + h, privateKey: h }
    },
  })
  for (const role of ROLES) {
    const w = xrpl.Wallet.generate('ecdsa-secp256k1' as never)
    ks.setWallet(role, { address: w.classicAddress, seed: w.seed!, algorithm: 'ecdsa-secp256k1' })
  }
  ks.setElGamal('pool', { publicKey: '03' + 'A'.repeat(64), privateKey: 'B'.repeat(64) })
  ks.setElGamal('issuer', { publicKey: '03' + 'C'.repeat(64), privateKey: 'D'.repeat(64) })
  ks.setMeta('cmptIssuanceId', FAKE_CMPT)
  return ks
}

/** The fake's ciphertext: 66 bytes whose tail is the amount, so decryptAmount works without keys. */
export const fakeCiphertext = (amount: number, tag = '02') => (tag + amount.toString(16).padStart(130, '0')).toUpperCase()

export type FakeLedger = Ledger & {
  index: number
  advance(n: number): void
  failNext(engineResult: string): void
  throwNext(message: string): void
  submitted: Array<{ blob: string; tx: Record<string, unknown>; result: SubmitResult }>
  setConfidential(address: string, b: ConfidentialBalance): void
}

export function createFakeLedger(keystore: KeyStore): FakeLedger {
  const sponsor = keystore.getWallet('sponsor').address
  const accounts = new Set<string>()
  const seqs = new Map<string, number>()
  const conf = new Map<string, ConfidentialBalance>()
  let fail: string | undefined
  let throwMsg: string | undefined
  const nextSeq = (a: string) => {
    const s = seqs.get(a) ?? 100
    seqs.set(a, s + 10)
    return s
  }
  const base = (account: string, publicKey?: string) => ({
    Account: account,
    Sponsor: sponsor,
    SponsorFlags: 1,
    Fee: '12',
    Sequence: nextSeq(account),
    LastLedgerSequence: ledger.index + 150,
    ...(publicKey ? { SigningPubKey: publicKey } : {}),
  })

  const ledger: FakeLedger = {
    network: 'devnet',
    mode: 'mock',
    issuanceId: keystore.getMeta('cmptIssuanceId') ?? FAKE_CMPT,
    index: 1000,
    submitted: [],
    advance(n) {
      ledger.index += n
    },
    failNext(e) {
      fail = e
    },
    throwNext(m) {
      throwMsg = m
    },
    setConfidential(address, b) {
      conf.set(address, b)
    },
    async ledgerIndex() {
      return ledger.index
    },
    async accountExists(a) {
      return accounts.has(a)
    },
    async ensureAccount(a) {
      if (accounts.has(a)) return { created: false }
      accounts.add(a)
      return { created: true, hash: sha512Half(Buffer.from('create:' + a).toString('hex')) }
    },
    async buildOnboarding(p) {
      const b = base(p.address, p.publicKey)
      return {
        TransactionType: 'Batch',
        ...b,
        Flags: 0x10000,
        Fee: '60',
        RawTransactions: [
          {
            RawTransaction: {
              TransactionType: 'ConfidentialMPTMergeInbox',
              Account: p.address,
              Sequence: b.Sequence + 1,
              MPTokenIssuanceID: ledger.issuanceId,
              Flags: 0x40000000,
              Fee: '0',
              SigningPubKey: '',
            },
          },
        ],
        BatchSigners: [
          { BatchSigner: { Account: sponsor, SigningPubKey: '02' + '1'.repeat(64), TxnSignature: 'AB'.repeat(70) } },
        ],
      } as UnsignedTx
    },
    async buildSend(p) {
      return {
        TransactionType: 'ConfidentialMPTSend',
        ...base(p.from, p.publicKey),
        Destination: p.to,
        MPTokenIssuanceID: ledger.issuanceId,
        SenderEncryptedAmount: fakeCiphertext(p.amountMinor, '02'),
        DestinationEncryptedAmount: fakeCiphertext(p.amountMinor, '03'),
        IssuerEncryptedAmount: fakeCiphertext(p.amountMinor, '02'),
        ZKProof: 'DD'.repeat(96),
      } as UnsignedTx
    },
    async buildMergeInbox(p) {
      return { TransactionType: 'ConfidentialMPTMergeInbox', ...base(p.account, p.publicKey), MPTokenIssuanceID: ledger.issuanceId } as UnsignedTx
    },
    async buildConvert(p) {
      return { TransactionType: 'ConfidentialMPTConvert', ...base(p.account), MPTokenIssuanceID: ledger.issuanceId, MPTAmount: String(p.amountMinor) } as UnsignedTx
    },
    async prepareSponsored(tx, opts) {
      return { ...tx, ...base(tx.Account, opts?.publicKey) } as UnsignedTx
    },
    async submitUserSigned(blob) {
      if (throwMsg) {
        const m = throwMsg
        throwMsg = undefined
        throw new Error(m)
      }
      const tx = decode(blob) as Record<string, unknown>
      if (tx.Sponsor !== sponsor) throw new Error('tx is not sponsored by this backend')
      const { TxnSignature, ...unsigned } = tx
      let engineResult = 'tesSUCCESS'
      if (typeof TxnSignature !== 'string' || !rk.verify(encodeForSigning(unsigned as never), TxnSignature, String(tx.SigningPubKey))) engineResult = 'temBAD_SIGNATURE'
      else if (Number(tx.LastLedgerSequence) < ledger.index) engineResult = 'tefMAX_LEDGER'
      if (fail) {
        engineResult = fail
        fail = undefined
      }
      // The ledger hash differs from the hash at signing (sponsor co-signature).
      const result: SubmitResult = { validated: engineResult === 'tesSUCCESS', engineResult, hash: sha512Half(blob + '53504E00'), ledgerIndex: ledger.index }
      ledger.submitted.push({ blob, tx, result })
      return result
    },
    async submitAs(_role, tx) {
      return { validated: true, engineResult: 'tesSUCCESS', hash: sha512Half(Buffer.from(JSON.stringify(tx)).toString('hex')) }
    },
    async confidentialBalance(address: string, _key: ElGamalKeyPair) {
      return conf.get(address) ?? { spendableMinor: 0, inboxMinor: 0 }
    },
    async decryptAmount(ct) {
      return Number.parseInt(ct.slice(2), 16)
    },
    async mptBalance() {
      return 0
    },
    watchAccount() {
      return () => {}
    },
    async accountTx(): Promise<LedgerTxEvent[]> {
      return []
    },
    async txByHash() {
      return null
    },
    async close() {},
  }
  return ledger
}

export type FakePool = PoolWorker & {
  expected: Array<{ intentId: string; txHash: string; from: string; amountMinor: number }>
  payouts: Array<{ intentId: string; to: string; amountMinor: number }>
  mints: Array<{ amountMinor: number; reference: string }>
  merges: string[]
  emit(e: PoolEvent): void
  /** When false, expectDeposit/payout only record; the test emits events itself. */
  auto: boolean
  failPayouts: boolean
}

let hashN = 0
const fakeHash = (tag: string) => sha512Half(Buffer.from(`${tag}:${++hashN}`).toString('hex'))

export function createFakePool(opts: { auto?: boolean } = {}): FakePool {
  const listeners: Record<string, Array<(e: PoolEvent) => void>> = { received: [], paidOut: [], failed: [] }
  const emit = (e: PoolEvent) => {
    for (const l of listeners[e.type] ?? []) l(e)
  }
  const later = (f: () => void) => setTimeout(f, 1)
  const pool: FakePool = {
    auto: opts.auto ?? true,
    failPayouts: false,
    expected: [],
    payouts: [],
    mints: [],
    merges: [],
    emit,
    async start() {},
    async stop() {},
    expectDeposit(i) {
      pool.expected.push(i)
      if (pool.auto) later(() => emit({ type: 'received', ...i }))
    },
    on(event, cb) {
      listeners[event].push(cb)
    },
    async payout(i) {
      pool.payouts.push(i)
      if (pool.failPayouts) throw new Error('payout refused')
      const hash = fakeHash('payout')
      if (pool.auto) later(() => emit({ type: 'paidOut', intentId: i.intentId, txHash: hash, to: i.to, amountMinor: i.amountMinor }))
      return { hash }
    },
    async mintIn(amountMinor, reference) {
      pool.mints.push({ amountMinor, reference })
      return { hash: fakeHash('mint') }
    },
    async mergeInboxFor(address) {
      pool.merges.push(address)
      return { hash: fakeHash('merge') }
    },
    status() {
      return { spendableMinor: 0, inboxMinor: 0, queue: 0 }
    },
  }
  return pool
}
