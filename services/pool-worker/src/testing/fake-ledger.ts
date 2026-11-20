// In-test fake Ledger for the pool worker: scripted deposits, sequences and LastLedgerSequence enforced,
// controllable failures (fail, throw, hang before/after the tx lands), and a record of every call.
// It does NOT serialise submits, so a test can prove the worker does. Fake ciphertexts are "ENC:<amount>".
import { randomBytes } from 'node:crypto'
import type { KeyStore, Ledger, LedgerTxEvent, SubmitResult, UnsignedTx, WalletRole } from '@zecca/contracts'
import { createMemoryKeyStore } from '@zecca/keystore'

export const ISSUANCE = '00000001AABBCCDDEEFF00112233445566778899AABBCCDD'
export const ADDR = { pool: 'rFakePoolAccount1111111111111', issuer: 'rFakeIssuerAccount11111111111', relayer: 'rFakeRelayerAccount1111111111', sponsor: 'rFakeSponsorAccount1111111111' }

export function fakeKeyStore(): KeyStore {
  const ks = createMemoryKeyStore({ generateElGamal: () => ({ publicKey: 'fake-pub', privateKey: 'fake-priv' }) })
  for (const [role, address] of Object.entries(ADDR)) ks.setWallet(role as WalletRole, { address, seed: 'test-only-not-a-seed', algorithm: 'ecdsa-secp256k1' })
  ks.setElGamal('pool', { publicKey: 'pool-pub', privateKey: 'pool-priv' })
  ks.setMeta('cmptIssuanceId', ISSUANCE)
  return ks
}

export const enc = (amountMinor: number) => `ENC:${amountMinor}`
const hash = () => randomBytes(32).toString('hex').toUpperCase()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Bal = { spendableMinor: number; inboxMinor: number; publicMinor: number }
type Hang = { apply: boolean }

export type FakeLedger = Ledger & {
  t: {
    deposit(o: { from: string; amountMinor: number; encryptedAmountMinor?: number; engineResult?: string; issuanceId?: string; stream?: boolean; to?: string }): LedgerTxEvent
    redeliver(e: LedgerTxEvent): void
    advance(n: number): void
    /** The next submit (of `txType` when given) returns this engine result; a tec consumes the sequence like the real ledger. */
    failNextSubmit(engineResult: string, txType?: string): void
    throwNextSubmit(message: string, txType?: string): void
    /** The next submit never returns. apply: true lands the tx first (a crash after submit). */
    hangNextSubmit(h: Hang, txType?: string): void
    throwNext(method: 'decryptAmount' | 'accountTx' | 'txByHash', message: string): void
    bal(address: string): Bal
    setBal(address: string, b: Partial<Bal>): void
    calls: { method: string; args: unknown[] }[]
    submits: { role: WalletRole; tx: UnsignedTx; result?: SubmitResult }[]
    maxActive: Map<string, number>
    events: LedgerTxEvent[]
    watchers(): number
  }
}

export function createFakeLedger(opts: { submitDelayMs?: number; startLedger?: number } = {}): FakeLedger {
  const delay = opts.submitDelayMs ?? 2
  let index = opts.startLedger ?? 100
  const seq = new Map<string, number>()
  const bals = new Map<string, Bal>()
  const events: LedgerTxEvent[] = []
  const watchers = new Map<string, Set<(e: LedgerTxEvent) => void>>()
  const calls: { method: string; args: unknown[] }[] = []
  const submits: { role: WalletRole; tx: UnsignedTx; result?: SubmitResult }[] = []
  const active = new Map<string, number>()
  const maxActive = new Map<string, number>()
  type Plan = ({ fail: string } | { throw: string } | { hang: Hang }) & { type?: string }
  const submitPlan: Plan[] = []
  const takePlan = (txType: string): Plan | undefined => {
    const i = submitPlan.findIndex((p) => !p.type || p.type === txType)
    return i < 0 ? undefined : submitPlan.splice(i, 1)[0]
  }
  const throwPlan = new Map<string, string>()

  const nextSeq = (a: string) => seq.get(a) ?? 1
  const bal = (a: string): Bal => {
    let b = bals.get(a)
    if (!b) bals.set(a, (b = { spendableMinor: 0, inboxMinor: 0, publicMinor: 0 }))
    return b
  }
  const amountOf = (ct: unknown) => {
    const m = /^ENC:(\d+)$/.exec(String(ct))
    if (!m) throw new Error('could not decrypt amount')
    return Number(m[1])
  }
  const notify = (e: LedgerTxEvent) => {
    const touched = new Set([String(e.tx.Account), String(e.tx.Destination ?? ''), String(e.tx.Delegate ?? '')])
    for (const a of touched) for (const cb of watchers.get(a) ?? []) queueMicrotask(() => cb(e))
  }
  const record = (tx: Record<string, unknown>, engineResult: string): LedgerTxEvent => {
    index += 1
    const h = hash()
    const e: LedgerTxEvent = { hash: h, ledgerIndex: index, validated: true, engineResult, tx: { ...tx, hash: h }, meta: { TransactionResult: engineResult } }
    events.push(e)
    return e
  }
  const maybeThrow = (method: string) => {
    const m = throwPlan.get(method)
    if (m !== undefined) {
      throwPlan.delete(method)
      throw new Error(m)
    }
  }

  function apply(tx: Record<string, unknown>) {
    const a = String(tx.Account)
    switch (tx.TransactionType) {
      case 'ConfidentialMPTSend': {
        const n = amountOf(tx.DestinationEncryptedAmount)
        if (bal(a).spendableMinor < n) return 'tecBAD_PROOF'
        bal(a).spendableMinor -= n
        bal(String(tx.Destination)).inboxMinor += n
        return 'tesSUCCESS'
      }
      case 'ConfidentialMPTMergeInbox': {
        const b = bal(a)
        b.spendableMinor += b.inboxMinor
        b.inboxMinor = 0
        return 'tesSUCCESS'
      }
      case 'ConfidentialMPTConvert': {
        const n = Number(tx.MPTAmount)
        if (bal(a).publicMinor < n) return 'tecINSUFFICIENT_FUNDS'
        bal(a).publicMinor -= n
        bal(a).inboxMinor += n
        return 'tesSUCCESS'
      }
      case 'Payment': {
        const amt = tx.Amount as { value: string }
        bal(String(tx.Destination)).publicMinor += Number(amt.value)
        return 'tesSUCCESS'
      }
      default:
        return 'tesSUCCESS'
    }
  }

  const base = (account: string) => ({ Account: account, Sequence: nextSeq(account), Fee: '12', MPTokenIssuanceID: ISSUANCE })

  const ledger: FakeLedger = {
    network: 'devnet',
    mode: 'mock',
    issuanceId: ISSUANCE,
    async ledgerIndex() {
      return index
    },
    async accountExists() {
      return true
    },
    async ensureAccount() {
      return { created: false }
    },
    async buildOnboarding() {
      throw new Error('not used by the pool worker')
    },
    async buildSend(p) {
      calls.push({ method: 'buildSend', args: [p] })
      if (!p.sponsored && bal(p.from).spendableMinor < p.amountMinor) throw new Error(`insufficient spendable balance (${bal(p.from).spendableMinor} < ${p.amountMinor})`)
      return { TransactionType: 'ConfidentialMPTSend', ...base(p.from), Destination: p.to, DestinationEncryptedAmount: enc(p.amountMinor), SenderEncryptedAmount: enc(p.amountMinor) }
    },
    async buildMergeInbox(p) {
      calls.push({ method: 'buildMergeInbox', args: [p] })
      return { TransactionType: 'ConfidentialMPTMergeInbox', ...base(p.account), ...(p.delegate ? { Delegate: p.delegate } : {}) }
    },
    async buildConvert(p) {
      calls.push({ method: 'buildConvert', args: [p] })
      return { TransactionType: 'ConfidentialMPTConvert', ...base(p.account), MPTAmount: String(p.amountMinor) }
    },
    async prepareSponsored(tx) {
      return tx
    },
    async submitUserSigned() {
      throw new Error('not used by the pool worker')
    },
    async submitAs(role, txIn) {
      const entry: { role: WalletRole; tx: UnsignedTx; result?: SubmitResult } = { role, tx: { ...txIn } }
      submits.push(entry)
      const tx: Record<string, unknown> = { ...txIn }
      const acct = String(tx.Account)
      if (tx.Sequence === undefined) tx.Sequence = nextSeq(acct)
      active.set(acct, (active.get(acct) ?? 0) + 1)
      maxActive.set(acct, Math.max(maxActive.get(acct) ?? 0, active.get(acct)!))
      try {
        await sleep(delay)
        const plan = takePlan(String(tx.TransactionType))
        if (plan && 'throw' in plan) throw new Error(plan.throw)
        if (plan && 'hang' in plan && !plan.hang.apply) return await new Promise<never>(() => {})
        let result: SubmitResult
        if (plan && 'fail' in plan) {
          result = { validated: false, engineResult: plan.fail, hash: hash() }
          if (plan.fail.startsWith('tec')) {
            seq.set(acct, Number(tx.Sequence) + 1)
            const e = record(tx, plan.fail)
            result = { validated: true, engineResult: plan.fail, hash: e.hash, ledgerIndex: e.ledgerIndex }
          }
        } else if (Number(tx.Sequence) < nextSeq(acct)) result = { validated: false, engineResult: 'tefPAST_SEQ', hash: hash() }
        else if (Number(tx.Sequence) > nextSeq(acct)) result = { validated: false, engineResult: 'terPRE_SEQ', hash: hash() }
        else if (tx.LastLedgerSequence !== undefined && Number(tx.LastLedgerSequence) < index) result = { validated: false, engineResult: 'tefMAX_LEDGER', hash: hash() }
        else {
          const r = apply(tx)
          seq.set(acct, Number(tx.Sequence) + 1)
          const e = record(tx, r)
          if (r === 'tesSUCCESS') notify(e)
          result = { validated: true, engineResult: r, hash: e.hash, ledgerIndex: e.ledgerIndex }
        }
        entry.result = result
        if (plan && 'hang' in plan) return await new Promise<never>(() => {}) // landed on the ledger, the caller never hears back
        return result
      } finally {
        active.set(acct, active.get(acct)! - 1)
      }
    },
    async confidentialBalance(address) {
      calls.push({ method: 'confidentialBalance', args: [address] })
      const b = bal(address)
      return { spendableMinor: b.spendableMinor, inboxMinor: b.inboxMinor }
    },
    async decryptAmount(ct, priv) {
      calls.push({ method: 'decryptAmount', args: [ct, priv] })
      maybeThrow('decryptAmount')
      return amountOf(ct)
    },
    async mptBalance(address) {
      return bal(address).publicMinor
    },
    watchAccount(address, cb) {
      let s = watchers.get(address)
      if (!s) watchers.set(address, (s = new Set()))
      s.add(cb)
      return () => void s!.delete(cb)
    },
    async accountTx(address, limit = 20) {
      calls.push({ method: 'accountTx', args: [address, limit] })
      maybeThrow('accountTx')
      return events.filter((e) => e.tx.Account === address || e.tx.Destination === address || e.tx.Delegate === address).reverse().slice(0, limit)
    },
    async txByHash(h) {
      calls.push({ method: 'txByHash', args: [h] })
      maybeThrow('txByHash')
      return events.find((e) => e.hash === h.toUpperCase()) ?? null
    },
    async close() {
      watchers.clear()
    },
    t: {
      deposit(o) {
        const from = o.from
        const tx = {
          TransactionType: 'ConfidentialMPTSend',
          Account: from,
          Sequence: nextSeq(from),
          Destination: o.to ?? ADDR.pool,
          MPTokenIssuanceID: o.issuanceId ?? ISSUANCE,
          DestinationEncryptedAmount: enc(o.encryptedAmountMinor ?? o.amountMinor),
          Sponsor: ADDR.sponsor,
        }
        seq.set(from, nextSeq(from) + 1)
        const result = o.engineResult ?? 'tesSUCCESS'
        if (result === 'tesSUCCESS') bal(tx.Destination).inboxMinor += o.encryptedAmountMinor ?? o.amountMinor
        const e = record(tx, result)
        if (o.stream !== false) notify(e)
        return e
      },
      redeliver: (e) => notify(e),
      advance(n) {
        index += n
      },
      failNextSubmit: (r, type) => void submitPlan.push({ fail: r, type }),
      throwNextSubmit: (m, type) => void submitPlan.push({ throw: m, type }),
      hangNextSubmit: (h, type) => void submitPlan.push({ hang: h, type }),
      throwNext: (method, m) => void throwPlan.set(method, m),
      bal: (a) => ({ ...bal(a) }),
      setBal: (a, b) => void Object.assign(bal(a), b),
      calls,
      submits,
      maxActive,
      events,
      watchers: () => [...watchers.values()].reduce((n, s) => n + s.size, 0),
    },
  }
  return ledger
}
