// In-memory Lithic sandbox for unit tests. Like the real one: simulateAuthorize calls our ASA endpoint (through `asa`),
// answers before the decision is readable (`lagReads`), records APPROVED as PENDING/APPROVED and a decline as
// DECLINED/DECLINED, declines a PAUSED card itself without calling ASA, and settles on simulateClearing.
import { LithicError, type LithicApi, type LithicCard, type LithicTx } from './lithic-api'
import { sampleAuthorization } from './lithic-sig'

type FakeCard = LithicCard & { pan: string; cvv: string; memo: string }

export type FakeLithic = LithicApi & {
  cards: Map<string, FakeCard>
  txs: Map<string, LithicTx>
  calls: string[]
  /** Lithic -> our ASA endpoint. Returns the `result` we answered (or throws when we did not answer). */
  asa?: (body: ReturnType<typeof sampleAuthorization>) => Promise<string>
  /** Reads of a new transaction that come back without a result. */
  lagReads: number
  enrolled?: string
  secret: string
  /** Makes the next call of this method throw. */
  failNext(method: keyof LithicApi, status?: number): void
}

export function createFakeLithic(o: { secret?: string } = {}): FakeLithic {
  let n = 0
  const reads = new Map<string, number>()
  const fail = new Map<string, number>()
  const check = (m: string) => {
    f.calls.push(m)
    const s = fail.get(m)
    if (s !== undefined) {
      fail.delete(m)
      throw new LithicError(s, `Lithic ${m} -> HTTP ${s}: fake failure`)
    }
  }
  const byPan = (pan: string) => [...f.cards.values()].find((c) => c.pan === pan)
  const pub = (c: FakeCard): LithicCard => ({ token: c.token, last4: c.last4, expMonth: c.expMonth, expYear: c.expYear, state: c.state, pan: c.pan, cvv: c.cvv })

  const f: FakeLithic = {
    baseUrl: 'https://sandbox.lithic.com',
    cards: new Map(),
    txs: new Map(),
    calls: [],
    lagReads: 0,
    secret: o.secret ?? 'whsec_' + Buffer.from('fake-lithic-asa-secret').toString('base64'),
    failNext(method, status = 500) {
      fail.set(method, status)
    },
    async createCard({ memo }) {
      check('createCard')
      const i = ++n
      const last4 = String(4400 + (i % 100)).padStart(4, '0')
      const c: FakeCard = { token: `card-${i}`, last4, expMonth: 11, expYear: 2029, state: 'OPEN', pan: `411111111111${last4}`, cvv: String(100 + i).slice(-3), memo }
      f.cards.set(c.token, c)
      return pub(c)
    },
    async getCard(token) {
      check('getCard')
      const c = f.cards.get(token)
      if (!c) throw new LithicError(404, 'Lithic GET /v1/cards -> HTTP 404: not found')
      return pub(c)
    },
    async setCardState(token, state) {
      check('setCardState')
      const c = f.cards.get(token)
      if (!c) throw new LithicError(404, 'not found')
      c.state = state
      return pub(c)
    },
    async getTransaction(token) {
      check('getTransaction')
      const tx = f.txs.get(token)
      if (!tx) return null
      const r = (reads.get(token) ?? 0) + 1
      reads.set(token, r)
      if (r <= f.lagReads) return { token, status: 'PENDING' }
      return structuredClone(tx)
    },
    async listTransactions({ cardToken }) {
      check('listTransactions')
      return [...f.txs.values()].filter((t) => t.card_token === cardToken).map((t) => structuredClone(t))
    },
    async simulateAuthorize({ amount, descriptor, pan }) {
      check('simulateAuthorize')
      const c = byPan(pan)
      if (!c) throw new LithicError(400, 'Lithic POST /v1/simulate/authorize -> HTTP 400: invalid pan')
      const token = `tx-${++n}`
      let result: string
      if (c.state !== 'OPEN') result = 'CARD_PAUSED'
      else {
        try {
          result = f.asa ? await f.asa(sampleAuthorization({ token, cardToken: c.token, amount, descriptor })) : 'APPROVED'
        } catch {
          result = 'ISSUER_TIMEOUT'
        }
      }
      const approved = result === 'APPROVED'
      f.txs.set(token, {
        token,
        card_token: c.token,
        status: approved ? 'PENDING' : 'DECLINED',
        result: approved ? 'APPROVED' : 'DECLINED',
        amount,
        amounts: { cardholder: { amount } },
        merchant: { descriptor },
        events: [{ token: `ev-${++n}`, type: 'AUTHORIZATION', amount, result: approved ? 'APPROVED' : 'DECLINED', detailed_results: [approved ? 'APPROVED' : result] }],
        created: new Date().toISOString(),
      })
      return { token }
    },
    async simulateClearing({ token, amount }) {
      check('simulateClearing')
      const tx = f.txs.get(token)
      if (!tx || tx.result !== 'APPROVED') throw new LithicError(400, 'not clearable')
      const a = amount ?? tx.amount ?? 0
      tx.status = 'SETTLED'
      tx.settled_amount = a
      tx.events = [...(tx.events ?? []), { token: `ev-${++n}`, type: 'CLEARING', amount: a, result: 'APPROVED' }]
    },
    async simulateVoid({ token }) {
      check('simulateVoid')
      const tx = f.txs.get(token)
      if (!tx || tx.status !== 'PENDING') throw new LithicError(400, 'not voidable')
      // As observed on the sandbox (2026-11-20): status VOIDED, an AUTHORIZATION_REVERSAL event with a negative amount.
      tx.status = 'VOIDED'
      tx.events = [...(tx.events ?? []), { token: `ev-${++n}`, type: 'AUTHORIZATION_REVERSAL', amount: -(tx.amount ?? 0), result: 'APPROVED' }]
    },
    async simulateReturn({ amount, descriptor, pan }) {
      check('simulateReturn')
      const c = byPan(pan)
      if (!c) throw new LithicError(400, 'invalid pan')
      const token = `tx-${++n}`
      f.txs.set(token, {
        token,
        card_token: c.token,
        status: 'SETTLED',
        result: 'APPROVED',
        amount,
        amounts: { cardholder: { amount } },
        merchant: { descriptor },
        // As observed on the sandbox: status SETTLED, one RETURN event with a negative amount.
        events: [{ token: `ev-${++n}`, type: 'RETURN', amount: -amount, result: 'APPROVED' }],
        created: new Date().toISOString(),
      })
      return { token }
    },
    async authStreamSecret() {
      check('authStreamSecret')
      return f.secret
    },
    async enrollAsa(url) {
      check('enrollAsa')
      f.enrolled = url
    },
    async asaEnrollment() {
      check('asaEnrollment')
      return { data: f.enrolled ? [{ url: f.enrolled }] : [] }
    },
  }
  return f
}
