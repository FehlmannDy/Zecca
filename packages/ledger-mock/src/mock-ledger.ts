// In-memory Ledger (LEDGER_MODE=mock). Same interface and state machine as the live ledger:
// real tx JSON, real signature checks on user-signed blobs, sponsor co-signature changes the hash,
// sequences and LastLedgerSequence enforced, inbox vs spendable tracked, validated after a short delay.
// Ciphertexts are fake: they encode the amount, so decryptAmount works without keys. Never used on a real network.
import { randomBytes } from 'node:crypto'
import { decode, encode, encodeForSigning, encodeForSigningBatch, encodeForSigningSponsor } from 'ripple-binary-codec'
import * as rk from 'ripple-keypairs'
import { decodeAccountID } from 'ripple-address-codec'
import xrpl from 'xrpl'
import type {
  ConfidentialBalance,
  ElGamalKeyPair,
  KeyStore,
  Ledger,
  LedgerTxEvent,
  Network,
  OnboardingParams,
  SendParams,
  SubmitResult,
  UnsignedTx,
  WalletRole,
} from '@zecca/contracts'

const tfInnerBatchTxn = 0x40000000
const tfAllOrNothing = 0x10000
const tfSponsorCreatedAccount = 0x80000
const spfFee = 1
const spfReserve = 2
const LLS_WINDOW = 150
const CT_PREFIX = 'C0FFEE'

/** A fake 66-byte ciphertext that carries the amount (hex, uppercase). */
export function mockCiphertext(amountMinor: number): string {
  const amt = BigInt(amountMinor).toString(16).padStart(16, '0')
  return (CT_PREFIX + amt + randomBytes(66 - 3 - 8).toString('hex')).toUpperCase()
}
function readMockCiphertext(ct: string): number {
  const h = ct.toUpperCase()
  if (!h.startsWith(CT_PREFIX)) throw new Error('could not decrypt amount (not a mock ciphertext)')
  return Number(BigInt('0x' + h.slice(6, 22)))
}
const hex = (n: number) => randomBytes(n).toString('hex').toUpperCase()

type Holding = { authorized: boolean; keyRegistered: boolean; publicMinor: number; spendableMinor: number; inboxMinor: number }
type Account = { address: string; sequence: number; drops: number; holdings: Map<string, Holding>; delegates: Map<string, Set<string>> }

export type MockLedgerOptions = {
  keystore: KeyStore
  network?: Network
  validationDelayMs?: number
  startLedger?: number
  issuanceId?: string
}

export type MockLedger = Ledger & {
  mock: {
    balances(address: string, issuanceId?: string): { spendableMinor: number; inboxMinor: number; publicMinor: number }
    credit(address: string, minor: number): void
    advance(ledgers: number): void
    failNext(engineResult: string): void
    txs(): LedgerTxEvent[]
  }
}

export function createMockLedger(opts: MockLedgerOptions): MockLedger {
  const { keystore } = opts
  const network = opts.network ?? 'devnet'
  const delay = opts.validationDelayMs ?? 0
  const issuanceId = (opts.issuanceId ?? keystore.getMeta('cmptIssuanceId') ?? hex(24)).toUpperCase()
  let index = opts.startLedger ?? 1000
  let failNextResult: string | null = null
  const accounts = new Map<string, Account>()
  const log: LedgerTxEvent[] = []
  const watchers = new Map<string, Set<(e: LedgerTxEvent) => void>>()
  const queues = new Map<string, Promise<unknown>>()
  const issuers = new Map<string, string>() // issuanceId -> issuer address
  issuers.set(issuanceId, keystore.hasWallet('issuer') ? keystore.getWallet('issuer').address : '')

  const sponsorAddr = () => keystore.getWallet('sponsor').address
  const wallet = (role: WalletRole) => {
    const s = keystore.getWallet(role)
    return xrpl.Wallet.fromSeed(s.seed, { algorithm: s.algorithm as never })
  }

  function account(address: string): Account | undefined {
    return accounts.get(address)
  }
  function createAccount(address: string, drops: number): Account {
    const a: Account = { address, sequence: index, drops, holdings: new Map(), delegates: new Map() }
    accounts.set(address, a)
    return a
  }
  function holding(a: Account, iss: string): Holding {
    let h = a.holdings.get(iss)
    if (!h) {
      h = { authorized: false, keyRegistered: false, publicMinor: 0, spendableMinor: 0, inboxMinor: 0 }
      a.holdings.set(iss, h)
    }
    return h
  }

  // System accounts exist from the start, funded; the pool and the demo shop hold the token with a registered key.
  for (const role of ['sponsor', 'issuer', 'pool', 'relayer', 'cardSettlement', 'kycIssuer', 'marketIssuer', 'oracle', 'demoShop'] as WalletRole[]) {
    if (keystore.hasWallet(role)) createAccount(keystore.getWallet(role).address, 1_000_000_000)
  }
  for (const role of ['pool', 'demoShop', 'cardSettlement'] as WalletRole[]) {
    if (!keystore.hasWallet(role)) continue
    const h = holding(account(keystore.getWallet(role).address)!, issuanceId)
    h.authorized = true
    h.keyRegistered = true
  }

  const serial = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve()
    const p = prev.then(fn, fn)
    queues.set(key, p.catch(() => undefined))
    return p
  }
  const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

  // ---------- applying transactions ----------
  class Tec extends Error {
    constructor(public code: string, msg?: string) {
      super(msg ?? code)
    }
  }

  function mptAmount(v: unknown): { iss: string; value: number } | null {
    if (v && typeof v === 'object' && 'mpt_issuance_id' in v) {
      const o = v as { mpt_issuance_id: string; value: string }
      return { iss: o.mpt_issuance_id.toUpperCase(), value: Number(o.value) }
    }
    return null
  }

  /** Validate and apply one (possibly inner) tx to a scratch copy. Returns accounts touched. */
  function applyOne(tx: Record<string, unknown>, touched: Set<string>): void {
    const acct = account(String(tx.Account))
    if (!acct) throw new Tec('terNO_ACCOUNT')
    touched.add(acct.address)
    const type = String(tx.TransactionType)
    const iss = String(tx.MPTokenIssuanceID ?? issuanceId).toUpperCase()
    switch (type) {
      case 'MPTokenAuthorize': {
        holding(acct, iss).authorized = true
        return
      }
      case 'Payment': {
        const dest = account(String(tx.Destination))
        const m = mptAmount(tx.Amount)
        if (m) {
          if (!dest) throw new Tec('tecNO_DST')
          touched.add(dest.address)
          const dh = holding(dest, m.iss)
          if (!dh.authorized && issuers.get(m.iss) !== dest.address) throw new Tec('tecNO_AUTH')
          if (issuers.get(m.iss) !== acct.address) {
            const sh = holding(acct, m.iss)
            if (sh.publicMinor < m.value) throw new Tec('tecINSUFFICIENT_FUNDS')
            sh.publicMinor -= m.value
          }
          if (issuers.get(m.iss) !== dest.address) dh.publicMinor += m.value
          return
        }
        const drops = Number(tx.Amount)
        if (!dest) {
          if (Number(tx.Flags ?? 0) & tfSponsorCreatedAccount || drops >= 1) {
            createAccount(String(tx.Destination), 0)
          }
        }
        const d = account(String(tx.Destination))!
        touched.add(d.address)
        if (acct.drops < drops) throw new Tec('tecUNFUNDED_PAYMENT')
        acct.drops -= drops
        d.drops += drops
        return
      }
      case 'ConfidentialMPTConvert': {
        const h = holding(acct, iss)
        if (!h.authorized) throw new Tec('tecNO_AUTH')
        const amt = Number(tx.MPTAmount ?? 0)
        if (h.publicMinor < amt) throw new Tec('tecINSUFFICIENT_FUNDS')
        h.publicMinor -= amt
        h.inboxMinor += amt
        h.keyRegistered = true
        return
      }
      case 'ConfidentialMPTMergeInbox': {
        const h = holding(acct, iss)
        h.spendableMinor += h.inboxMinor
        h.inboxMinor = 0
        return
      }
      case 'ConfidentialMPTSend': {
        const dest = account(String(tx.Destination))
        if (!dest) throw new Tec('tecNO_DST')
        touched.add(dest.address)
        const dh = holding(dest, iss)
        if (!dh.authorized || !dh.keyRegistered) throw new Tec('tecNO_PERMISSION')
        const amt = readMockCiphertext(String(tx.DestinationEncryptedAmount))
        const sh = holding(acct, iss)
        if (sh.spendableMinor < amt) throw new Tec('tecINSUFFICIENT_FUNDS')
        sh.spendableMinor -= amt
        dh.inboxMinor += amt
        return
      }
      case 'DelegateSet': {
        const to = String(tx.Authorize)
        const perms = (tx.Permissions as { Permission: { PermissionValue: string } }[] | undefined) ?? []
        acct.delegates.set(to, new Set(perms.map((p) => p.Permission.PermissionValue)))
        return
      }
      default:
        // CredentialCreate/Accept, AccountSet, OracleSet, TrustSet, MPTokenIssuanceCreate/Set...: recorded, no balance effect.
        return
    }
  }

  function snapshot() {
    return new Map([...accounts].map(([k, a]) => [k, { ...a, holdings: new Map([...a.holdings].map(([i, h]) => [i, { ...h }])), delegates: new Map(a.delegates) }]))
  }

  function verifySignature(tx: Record<string, unknown>): boolean {
    const sig = tx.TxnSignature as string | undefined
    const pub = tx.SigningPubKey as string | undefined
    if (!sig || !pub) return false
    const signer = tx.Delegate ? String(tx.Delegate) : String(tx.Account)
    if (rk.deriveAddress(pub) !== signer) return false
    const unsigned = { ...tx }
    delete unsigned.TxnSignature
    delete unsigned.SponsorSignature
    try {
      return rk.verify(encodeForSigning(unsigned as never), sig, pub)
    } catch {
      return false
    }
  }

  async function execute(signedTx: Record<string, unknown>, blob: string): Promise<SubmitResult> {
    await sleep(delay)
    const hash = xrpl.hashes.hashSignedTx(blob)
    const fail = (engineResult: string): SubmitResult => ({ validated: false, engineResult, hash })
    if (failNextResult) {
      const r = failNextResult
      failNextResult = null
      return fail(r)
    }
    if (!verifySignature(signedTx)) return fail('tefBAD_SIGNATURE')
    const acct = account(String(signedTx.Account))
    if (!acct) return fail('terNO_ACCOUNT')
    if (Number(signedTx.Sequence) < acct.sequence) return fail('tefPAST_SEQ')
    if (Number(signedTx.Sequence) > acct.sequence) return fail('terPRE_SEQ')
    if (signedTx.LastLedgerSequence !== undefined && Number(signedTx.LastLedgerSequence) < index) return fail('tefMAX_LEDGER')
    if (signedTx.Delegate) {
      const perms = acct.delegates.get(String(signedTx.Delegate))
      if (!perms?.has(String(signedTx.TransactionType))) return fail('tecNO_DELEGATE_PERMISSION')
    }
    const backup = snapshot()
    const touched = new Set<string>()
    try {
      if (signedTx.TransactionType === 'Batch') {
        const inners = (signedTx.RawTransactions as { RawTransaction: Record<string, unknown> }[]).map((r) => r.RawTransaction)
        let userTxs = 1
        for (const inner of inners) {
          if (!(Number(inner.Flags ?? 0) & tfInnerBatchTxn)) throw new Tec('temINVALID_INNER_BATCH')
          if (inner.Account === signedTx.Account) userTxs++
          applyOne(inner, touched)
        }
        acct.sequence += userTxs
      } else {
        applyOne(signedTx, touched)
        acct.sequence += 1
      }
    } catch (e) {
      accounts.clear()
      for (const [k, v] of backup) accounts.set(k, v)
      const code = e instanceof Tec ? e.code : 'tefEXCEPTION'
      // tec results consume the sequence on a real ledger; keep it simple and consistent: they do here too.
      if (code.startsWith('tec')) account(String(signedTx.Account))!.sequence += 1
      return { validated: code.startsWith('tec'), engineResult: code, hash, ledgerIndex: index }
    }
    index += 1
    const ev: LedgerTxEvent = {
      hash,
      ledgerIndex: index,
      validated: true,
      engineResult: 'tesSUCCESS',
      tx: { ...signedTx, hash },
      meta: { TransactionResult: 'tesSUCCESS' },
      closeTime: new Date().toISOString(),
    }
    log.push(ev)
    for (const addr of touched) for (const cb of watchers.get(addr) ?? []) queueMicrotask(() => cb(ev))
    return { validated: true, engineResult: 'tesSUCCESS', hash, ledgerIndex: index, meta: ev.meta }
  }

  // ---------- builders ----------
  const baseUser = (address: string, publicKey?: string) => {
    const a = account(address)
    if (!a) throw new Error(`account ${address} does not exist`)
    return {
      Account: address,
      Sequence: a.sequence,
      Fee: '12',
      LastLedgerSequence: index + LLS_WINDOW,
      ...(publicKey ? { SigningPubKey: publicKey.toUpperCase() } : {}),
    }
  }
  const sponsorFields = (reserve = false) => ({ Sponsor: sponsorAddr(), SponsorFlags: reserve ? spfFee | spfReserve : spfFee })
  const sendProof = () => hex(946)
  const convertProof = () => hex(64)
  const point = () => '02' + hex(32)

  function batchSigner(role: WalletRole, batch: Record<string, unknown>) {
    const w = wallet(role)
    const txIDs = (batch.RawTransactions as { RawTransaction: Record<string, unknown> }[]).map((r) => xrpl.hashes.hashSignedTx(encode(r.RawTransaction as never)))
    const msg = encodeForSigningBatch({ account: String(batch.Account), sequence: Number(batch.Sequence ?? 0), flags: Number(batch.Flags), txIDs, batchAccount: w.classicAddress } as never)
    return { BatchSigner: { Account: w.classicAddress, SigningPubKey: w.publicKey, TxnSignature: rk.sign(msg, w.privateKey) } }
  }
  const byAccountId = (a: { BatchSigner: { Account: string } }, b: { BatchSigner: { Account: string } }) =>
    Buffer.compare(Buffer.from(decodeAccountID(a.BatchSigner.Account)), Buffer.from(decodeAccountID(b.BatchSigner.Account)))

  const ledger: MockLedger = {
    network,
    mode: 'mock',
    issuanceId,
    async ledgerIndex() {
      return index
    },
    async accountExists(address) {
      return accounts.has(address)
    },
    async ensureAccount(address) {
      if (accounts.has(address)) return { created: false }
      const sponsor = wallet('sponsor')
      const res = await ledger.submitAs('sponsor', { TransactionType: 'Payment', Account: sponsor.classicAddress, Destination: address, Amount: '1', Flags: tfSponsorCreatedAccount })
      if (res.engineResult !== 'tesSUCCESS') throw new Error('sponsored account creation: ' + res.engineResult)
      return { created: true, hash: res.hash }
    },

    async buildOnboarding(p: OnboardingParams) {
      const base = baseUser(p.address, p.publicKey)
      const seq = base.Sequence
      const issuer = keystore.getWallet('issuer').address
      const inners: Record<string, unknown>[] = []
      let s = seq + 1
      inners.push({ TransactionType: 'MPTokenAuthorize', Account: p.address, Sequence: s++, MPTokenIssuanceID: issuanceId, Flags: tfInnerBatchTxn, Fee: '0', SigningPubKey: '', ...sponsorFields(true), SponsorSignature: { SigningPubKey: '' } })
      if (p.welcomeCreditMinor > 0) {
        inners.push({ TransactionType: 'Payment', Account: issuer, Destination: p.address, Amount: { mpt_issuance_id: issuanceId, value: String(p.welcomeCreditMinor) }, Flags: tfInnerBatchTxn, Fee: '0', SigningPubKey: '', Sequence: 0 })
      }
      inners.push({
        TransactionType: 'ConfidentialMPTConvert',
        Account: p.address,
        Sequence: s++,
        MPTokenIssuanceID: issuanceId,
        MPTAmount: String(p.welcomeCreditMinor),
        HolderEncryptionKey: p.holderKey.publicKey,
        HolderEncryptedAmount: mockCiphertext(p.welcomeCreditMinor),
        IssuerEncryptedAmount: mockCiphertext(p.welcomeCreditMinor),
        BlindingFactor: hex(32),
        ZKProof: convertProof(),
        Flags: tfInnerBatchTxn,
        Fee: '0',
        SigningPubKey: '',
      })
      inners.push({ TransactionType: 'ConfidentialMPTMergeInbox', Account: p.address, Sequence: s++, MPTokenIssuanceID: issuanceId, Flags: tfInnerBatchTxn, Fee: '0', SigningPubKey: '' })
      if (p.delegateMergeTo) {
        inners.push({ TransactionType: 'DelegateSet', Account: p.address, Sequence: s++, Authorize: p.delegateMergeTo, Permissions: [{ Permission: { PermissionValue: 'ConfidentialMPTMergeInbox' } }], Flags: tfInnerBatchTxn, Fee: '0', SigningPubKey: '', ...sponsorFields(true), SponsorSignature: { SigningPubKey: '' } })
      }
      const batch: Record<string, unknown> = {
        TransactionType: 'Batch',
        ...base,
        Fee: String(12 * (inners.length + 2)),
        Flags: tfAllOrNothing,
        ...sponsorFields(false),
        RawTransactions: inners.map((t) => ({ RawTransaction: t })),
      }
      const signers = [batchSigner('issuer', batch)]
      if (p.delegateMergeTo || true) signers.push(batchSigner('sponsor', batch))
      batch.BatchSigners = signers.sort(byAccountId)
      return batch as UnsignedTx
    },

    async buildSend(p: SendParams) {
      const base = baseUser(p.from, p.publicKey)
      const h = holding(account(p.from)!, issuanceId)
      if (h.spendableMinor < p.amountMinor) throw new Error(`insufficient spendable balance (${h.spendableMinor} < ${p.amountMinor})`)
      if (!Number.isSafeInteger(p.amountMinor) || p.amountMinor <= 0) throw new Error('amount must be a positive integer')
      const tx: Record<string, unknown> = {
        TransactionType: 'ConfidentialMPTSend',
        ...base,
        Destination: p.to,
        MPTokenIssuanceID: issuanceId,
        SenderEncryptedAmount: mockCiphertext(p.amountMinor),
        DestinationEncryptedAmount: mockCiphertext(p.amountMinor),
        IssuerEncryptedAmount: mockCiphertext(p.amountMinor),
        ZKProof: sendProof(),
        AmountCommitment: point(),
        BalanceCommitment: point(),
      }
      if (p.sponsored) Object.assign(tx, sponsorFields(false))
      else delete tx.LastLedgerSequence
      return tx as UnsignedTx
    },

    async buildMergeInbox(p) {
      if (p.delegate) {
        const d = account(p.delegate)
        if (!d) throw new Error(`delegate ${p.delegate} does not exist`)
        return { TransactionType: 'ConfidentialMPTMergeInbox', Account: p.account, Delegate: p.delegate, Sequence: account(p.account)!.sequence, Fee: '12', MPTokenIssuanceID: issuanceId } as UnsignedTx
      }
      const base = baseUser(p.account, p.publicKey)
      const tx: Record<string, unknown> = { TransactionType: 'ConfidentialMPTMergeInbox', ...base, MPTokenIssuanceID: issuanceId }
      if (p.sponsored) Object.assign(tx, sponsorFields(false))
      else delete tx.LastLedgerSequence
      return tx as UnsignedTx
    },

    async buildConvert(p: { account: string; amountMinor: number; holderKey: ElGamalKeyPair }) {
      const { LastLedgerSequence: _l, ...base } = baseUser(p.account)
      return {
        TransactionType: 'ConfidentialMPTConvert',
        ...base,
        MPTokenIssuanceID: issuanceId,
        MPTAmount: String(p.amountMinor),
        HolderEncryptionKey: p.holderKey.publicKey,
        HolderEncryptedAmount: mockCiphertext(p.amountMinor),
        IssuerEncryptedAmount: mockCiphertext(p.amountMinor),
        BlindingFactor: hex(32),
        ZKProof: convertProof(),
      } as UnsignedTx
    },

    async prepareSponsored(tx, o = {}) {
      return { ...tx, ...baseUser(tx.Account, o.publicKey), ...sponsorFields(Boolean(o.reserve)) } as UnsignedTx
    },

    async submitUserSigned(txBlob) {
      const tx = decode(txBlob) as Record<string, unknown>
      if (tx.Sponsor !== undefined && tx.Sponsor !== sponsorAddr()) throw new Error('tx is not sponsored by this backend')
      if (!tx.TxnSignature) throw new Error('user signature missing')
      let blob = txBlob
      if (tx.Sponsor !== undefined) {
        const sp = wallet('sponsor')
        const withSig = { ...tx, SponsorSignature: { SigningPubKey: sp.publicKey, TxnSignature: rk.sign(encodeForSigningSponsor(tx as never), sp.privateKey) } }
        blob = encode(withSig as never)
      }
      return serial(String(tx.Account), () => execute(tx, blob))
    },

    async submitAs(role, txIn) {
      const w = wallet(role)
      const key = String(txIn.Delegate ? txIn.Delegate : txIn.Account)
      return serial(key, async () => {
        const tx: Record<string, unknown> = { ...txIn }
        const owner = account(String(tx.Account))
        if (!owner) return { validated: false, engineResult: 'terNO_ACCOUNT', hash: '0'.repeat(64) }
        if (tx.Sequence === undefined) tx.Sequence = owner.sequence
        if (tx.Fee === undefined) tx.Fee = '12'
        const signed = w.sign(tx as never)
        return execute(decode(signed.tx_blob) as Record<string, unknown>, signed.tx_blob)
      })
    },

    async confidentialBalance(address, _key): Promise<ConfidentialBalance> {
      const a = account(address)
      const h = a?.holdings.get(issuanceId)
      return { spendableMinor: h?.spendableMinor ?? 0, inboxMinor: h?.inboxMinor ?? 0 }
    },
    async decryptAmount(ciphertextHex) {
      return readMockCiphertext(ciphertextHex)
    },
    async mptBalance(address, iss) {
      return account(address)?.holdings.get(iss.toUpperCase())?.publicMinor ?? 0
    },
    watchAccount(address, onTx) {
      let set = watchers.get(address)
      if (!set) watchers.set(address, (set = new Set()))
      set.add(onTx)
      return () => set!.delete(onTx)
    },
    async accountTx(address, limit = 20) {
      const out: LedgerTxEvent[] = []
      for (let i = log.length - 1; i >= 0 && out.length < limit; i--) {
        const t = log[i].tx
        const inner = (t.RawTransactions as { RawTransaction: Record<string, unknown> }[] | undefined)?.some((r) => r.RawTransaction.Account === address || r.RawTransaction.Destination === address)
        if (t.Account === address || t.Destination === address || t.Delegate === address || inner) out.push(log[i])
      }
      return out
    },
    async txByHash(hash) {
      return log.find((e) => e.hash === hash.toUpperCase()) ?? null
    },
    async close() {
      watchers.clear()
    },
    mock: {
      balances(address, iss = issuanceId) {
        const h = account(address)?.holdings.get(iss.toUpperCase())
        return { spendableMinor: h?.spendableMinor ?? 0, inboxMinor: h?.inboxMinor ?? 0, publicMinor: h?.publicMinor ?? 0 }
      },
      credit(address, minor) {
        const a = account(address) ?? createAccount(address, 1)
        const h = holding(a, issuanceId)
        h.authorized = true
        h.keyRegistered = true
        h.spendableMinor += minor
      },
      advance(n) {
        index += n
      },
      failNext(r) {
        failNextResult = r
      },
      txs: () => [...log],
    },
  }
  return ledger
}
