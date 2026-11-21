// In-memory backend for the mock API (NEXT_PUBLIC_API_MOCK=1). It follows the API's rules closely enough that
// the screens behave as they will on the real API: signed nonces, the prepared-tx check on submit, limits, the
// intent state machine (submitted -> received -> paid_out) and events. Persisted to localStorage in the browser.
import {
  DEFAULTS,
  feeMinor as feeOf,
  formatUsd,
  type Activity,
  type ActivityKind,
  type ErrorCode,
  type Features,
  type Intent,
  type IntentKind,
  type PaymentRequest,
  type PreparedTx,
  type PublicConfig,
  type PublicProfile,
  type Role,
  type Sale,
  type User,
  type ZeccaEvent,
} from '@zecca/contracts'
import * as fx from '@zecca/contracts/fixtures'

export const ALL_FEATURES_ON: Features = {
  ramp: true,
  withdraw: true,
  card: true,
  earn: true,
  market: true,
  identity: true,
  proofs: true,
  demoShop: true,
  passkey: false,
  googleLogin: false,
}

export class MockApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

/** identityMs: how long an identity check stays 'pending' before the wallet "answers". */
export type MockDelays = { submitMs: number; receiveMs: number; payoutMs: number; networkMs: number; identityMs: number }
export type MockStorage = { getItem(k: string): string | null; setItem(k: string, v: string): void }

type Pending =
  | { kind: 'onboarding'; address: string; publicKey: string; handle: string; displayName: string; role: Role; businessName?: string; email?: string }
  | { kind: 'send'; intentId: string }
  | { kind: 'credential_accept'; sessionId: string }
type PreparedRow = { prepared: PreparedTx; token: string; pending: Pending; used?: boolean }

type Data = {
  users: Record<string, User>
  balances: Record<string, { availableMinor: number; pendingMinor: number; updatedAt: string }>
  activity: Record<string, Activity[]>
  intents: Record<string, Intent>
  paymentRequests: Record<string, PaymentRequest>
  sales: Record<string, Sale[]>
  sessions: Record<string, { address: string; publicKey: string }>
  nonces: Record<string, { address: string; publicKey: string; message: string; expiresAt: string }>
  prepared: Record<string, PreparedRow>
  card: { state: 'OPEN' | 'PAUSED' | 'CLOSED' } | null
  /** Identity checks: who started them, when, the CredentialAccept to approve, and whether it was. */
  identity?: Record<string, { userId: string; startedAt: number; prepareId?: string; accepted?: boolean }>
  seq: number
}

const STORAGE_KEY = 'zecca.mockapi.v1'
/** Hex of "ZeccaKYC", the API's credential type. */
const CREDENTIAL_TYPE = '5A656363614B5943'
const now = () => new Date().toISOString()
const hex = (bytes: number) => {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}
export const randomId = (prefix: string) => `${prefix}_${hex(8).toLowerCase()}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function profileOf(u: User): PublicProfile {
  return { id: u.id, handle: u.handle, displayName: u.merchant?.businessName ?? u.displayName, isMerchant: u.role.includes('merchant') }
}

function seedData(): Data {
  const carla = fx.users.carla as User
  const bruno = fx.users.bruno as User
  const shop: User = { id: 'usr_shop', role: ['user', 'merchant'], handle: 'settearchi', displayName: 'Sette Archi', address: fx.ADDR.shop, tier: 1, createdAt: carla.createdAt, merchant: { businessName: 'Sette Archi', feeBps: 50 } }
  const users = { [carla.id]: carla, [bruno.id]: bruno, [shop.id]: shop }
  const bal = (m: number) => ({ availableMinor: m, pendingMinor: 0, updatedAt: now() })
  return {
    users,
    balances: { [carla.id]: bal(12_000), [bruno.id]: bal(3_400), [shop.id]: bal(0) },
    activity: { [carla.id]: [], [bruno.id]: [], [shop.id]: [] },
    intents: {},
    paymentRequests: { [fx.paymentRequests.created.id]: fx.paymentRequests.created as PaymentRequest, [fx.paymentRequests.expired.id]: fx.paymentRequests.expired as PaymentRequest },
    sales: { [bruno.id]: [...fx.sales] },
    sessions: {},
    nonces: {},
    prepared: {},
    card: null,
    seq: 5_402_000,
  }
}

export type MockState = ReturnType<typeof createMockState>

export function createMockState(opts: { features?: Partial<Features>; delays?: Partial<MockDelays>; storage?: MockStorage | null; config?: Partial<PublicConfig> } = {}) {
  const delays: MockDelays = { submitMs: 2500, receiveMs: 3000, payoutMs: 4000, networkMs: 250, identityMs: 3000, ...opts.delays }
  const config: PublicConfig = {
    ...(fx.config as PublicConfig),
    ledgerMode: 'mock',
    signerMode: 'mock',
    ...opts.config,
    features: { ...(fx.config.features as Features), ...opts.features },
  }

  let data: Data = seedData()
  if (opts.storage) {
    try {
      const raw = opts.storage.getItem(STORAGE_KEY)
      if (raw) data = { ...data, ...(JSON.parse(raw) as Data) }
    } catch {
      /* start fresh */
    }
  }
  const save = () => {
    try {
      opts.storage?.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
      /* storage full or blocked: the mock keeps working in memory */
    }
  }

  // ---------- events ----------
  type Listener = (e: ZeccaEvent) => void
  const listeners = new Map<string, Set<Listener>>() // userId -> listeners
  const requestListeners = new Map<string, Set<Listener>>() // paymentRequestId -> listeners
  function emit(userId: string | undefined, e: ZeccaEvent) {
    if (!userId) return
    listeners.get(userId)?.forEach((l) => l(e))
  }
  const ev = <T extends ZeccaEvent['type']>(type: T, d: Extract<ZeccaEvent, { type: T }>['data']) => ({ type, data: d, at: now() }) as ZeccaEvent

  // ---------- timers (settle() waits for every scheduled step, for tests) ----------
  const timers = new Set<Promise<void>>()
  function later(ms: number, fn: () => void) {
    const p = sleep(ms).then(fn).finally(() => timers.delete(p))
    timers.add(p)
  }

  // ---------- helpers ----------
  const fail = (status: number, code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
    throw new MockApiError(status, code, message, details)
  }
  function sessionOf(token: string | null) {
    const s = token ? data.sessions[token] : undefined
    if (!s) fail(401, 'unauthorized', 'Your session has ended. Sign in again.')
    return s!
  }
  function userByAddress(address: string) {
    return Object.values(data.users).find((u) => u.address === address)
  }
  function userOf(token: string | null) {
    const s = sessionOf(token)
    const u = userByAddress(s.address)
    if (!u) fail(404, 'not_signed_up', 'Finish signing up first.')
    return u!
  }
  function balanceOf(userId: string) {
    const b = (data.balances[userId] ??= { availableMinor: 0, pendingMinor: 0, updatedAt: now() })
    return { ...b }
  }
  function changeBalance(userId: string, dAvail: number, dPending = 0) {
    const b = (data.balances[userId] ??= { availableMinor: 0, pendingMinor: 0, updatedAt: now() })
    b.availableMinor += dAvail
    b.pendingMinor += dPending
    b.updatedAt = now()
    emit(userId, ev('balance.updated', { ...b }))
  }
  function addActivity(userId: string, a: Activity) {
    ;(data.activity[userId] ??= []).unshift(a)
    emit(userId, ev('activity.created', a))
  }
  function patchActivity(userId: string, intentId: string, patch: Partial<Activity>) {
    const a = data.activity[userId]?.find((x) => x.intentId === intentId)
    if (a) Object.assign(a, patch)
  }
  function setIntent(i: Intent, patch: Partial<Intent>) {
    Object.assign(i, patch, { updatedAt: now() })
    emit(i.fromUserId, ev('intent.updated', { ...i }))
    if (i.toUserId && i.toUserId !== i.fromUserId) emit(i.toUserId, ev('intent.updated', { ...i }))
  }
  function setRequest(pr: PaymentRequest, patch: Partial<PaymentRequest>) {
    Object.assign(pr, patch)
    const e = ev('payment_request.updated', { ...pr })
    emit(pr.merchantId, e)
    requestListeners.get(pr.id)?.forEach((l) => l(e))
  }
  function expireRequests() {
    for (const pr of Object.values(data.paymentRequests))
      if ((pr.status === 'created' || pr.status === 'opened') && Date.parse(pr.expiresAt) < Date.now()) setRequest(pr, { status: 'expired' })
  }
  function sendTx(account: string, publicKey: string): PreparedTx['tx'] {
    const p = fx.preparedSend.tx
    data.seq += 1
    return { ...p, Account: account, SigningPubKey: publicKey, Sequence: data.seq, LastLedgerSequence: data.seq + DEFAULTS.LLS_WINDOW }
  }
  function prepare(token: string, kind: PreparedTx['kind'], tx: PreparedTx['tx'], pending: Pending): PreparedTx {
    const prepared: PreparedTx = { prepareId: randomId('prep'), kind, tx, expiresAt: new Date(Date.now() + 8 * 60_000).toISOString() }
    data.prepared[prepared.prepareId] = { prepared, token, pending }
    return prepared
  }
  function checkLimits(u: User, amountMinor: number) {
    const lim = config.limits
    if (u.tier === 0 && amountMinor > lim.tier0.txCapMinor)
      fail(403, 'limit_reached', "You've reached the limit for unverified accounts. Verify your identity to lift it.", { limit: 'per_payment', capMinor: lim.tier0.txCapMinor, usedMinor: amountMinor })
    if (u.tier === 0) {
      const monthAgo = Date.now() - 30 * 86_400_000
      const sent = (data.activity[u.id] ?? []).filter((a) => a.direction === 'out' && a.status !== 'failed' && Date.parse(a.at) > monthAgo).reduce((s, a) => s + a.amountMinor, 0)
      if (sent + amountMinor > lim.tier0.monthlySendCapMinor)
        fail(403, 'limit_reached', "You've reached the limit for unverified accounts. Verify your identity to lift it.", { limit: 'monthly_send', capMinor: lim.tier0.monthlySendCapMinor, usedMinor: sent })
    }
    if (u.tier === 1 && amountMinor > lim.txCapMinor) fail(403, 'limit_reached', 'That is above the limit for one payment.', { limit: 'tx_cap', capMinor: lim.txCapMinor, usedMinor: amountMinor })
    const b = balanceOf(u.id)
    if (b.availableMinor < amountMinor) {
      const short = amountMinor - b.availableMinor
      fail(402, 'insufficient_funds', `You need ${formatUsd(short)} more.`, { shortMinor: short })
    }
  }
  function createIntent(kind: IntentKind, from: User, to: User | undefined, amountMinor: number, fee: number, extra: Partial<Intent> = {}): Intent {
    const t = now()
    const i: Intent = { id: randomId('int'), kind, status: 'created', fromUserId: from.id, toUserId: to?.id, amountMinor, feeMinor: fee, createdAt: t, updatedAt: t, ...extra }
    data.intents[i.id] = i
    return i
  }
  function activityFor(i: Intent, side: 'in' | 'out', counterparty: User | undefined, kind: ActivityKind = i.kind): Activity {
    return {
      id: randomId('act'),
      intentId: i.id,
      direction: side,
      kind,
      counterparty: counterparty ? profileOf(counterparty) : undefined,
      amountMinor: side === 'in' ? i.amountMinor - i.feeMinor : i.amountMinor,
      feeMinor: side === 'in' ? i.feeMinor : 0,
      status: 'pending',
      note: i.note,
      at: now(),
      ledger: { depositTxHash: i.depositTxHash, network: 'devnet', ciphertextPreview: hex(8) },
    }
  }

  // ---------- the intent state machine after a validated deposit ----------
  function afterDeposit(i: Intent) {
    const from = data.users[i.fromUserId]
    const to = i.toUserId ? data.users[i.toUserId] : undefined
    changeBalance(from.id, -i.amountMinor)
    addActivity(from.id, activityFor(i, 'out', to))
    later(delays.receiveMs, () => {
      setIntent(i, { status: 'received' })
      if (to) {
        changeBalance(to.id, 0, i.amountMinor - i.feeMinor)
        addActivity(to.id, activityFor(i, 'in', from))
      }
      if (i.paymentRequestId) {
        const pr = data.paymentRequests[i.paymentRequestId]
        if (pr) {
          setRequest(pr, { status: 'paid', paidAt: now(), intentId: i.id })
          ;(data.sales[pr.merchantId] ??= []).unshift({ id: randomId('sale'), paymentRequestId: pr.id, amountMinor: i.amountMinor, feeMinor: i.feeMinor, netMinor: i.amountMinor - i.feeMinor, payer: profileOf(from), reference: pr.reference, paidAt: now(), payoutStatus: 'pending' })
        }
      }
      patchActivity(from.id, i.id, { status: 'done' })
      save()
      later(delays.payoutMs, () => {
        setIntent(i, { status: 'paid_out', payoutTxHash: hex(32) })
        if (to) {
          changeBalance(to.id, i.amountMinor - i.feeMinor, -(i.amountMinor - i.feeMinor))
          patchActivity(to.id, i.id, { status: 'done', ledger: { depositTxHash: i.depositTxHash, payoutTxHash: i.payoutTxHash, network: 'devnet', ciphertextPreview: hex(8) } })
        }
        patchActivity(from.id, i.id, { ledger: { depositTxHash: i.depositTxHash, payoutTxHash: i.payoutTxHash, network: 'devnet', ciphertextPreview: hex(8) } })
        if (i.paymentRequestId) {
          const pr = data.paymentRequests[i.paymentRequestId]
          const sale = pr && data.sales[pr.merchantId]?.find((s) => s.paymentRequestId === pr.id)
          if (sale) sale.payoutStatus = 'done'
        }
        save()
      })
    })
  }

  function credit(u: User, amountMinor: number, kind: ActivityKind, note?: string, network: 'devnet' | 'testnet' = 'devnet') {
    const i = createIntent('p2p', u, u, amountMinor, 0, { fromUserId: 'usr_zecca', toUserId: u.id, status: 'paid_out', note })
    changeBalance(u.id, amountMinor)
    addActivity(u.id, { id: randomId('act'), intentId: i.id, direction: 'in', kind, amountMinor, feeMinor: 0, status: 'done', note, at: now(), ledger: { depositTxHash: hex(32), network } })
    save()
    return i
  }

  return {
    config,
    delays,
    data: () => data,
    save,
    settle: async () => {
      while (timers.size) await Promise.all([...timers])
    },
    reset() {
      data = seedData()
      save()
    },
    fail,
    sessionOf,
    userOf,
    userByAddress,
    balanceOf,
    profileOf,
    expireRequests,
    subscribe(token: string, l: Listener) {
      const s = sessionOf(token)
      const u = userByAddress(s.address)
      const key = u?.id ?? s.address
      const set = listeners.get(key) ?? new Set()
      set.add(l)
      listeners.set(key, set)
      return () => set.delete(l)
    },
    subscribeRequest(id: string, l: Listener) {
      const set = requestListeners.get(id) ?? new Set()
      set.add(l)
      requestListeners.set(id, set)
      return () => set.delete(l)
    },

    // ---------- auth ----------
    newNonce(address: string, publicKey: string) {
      const nonce = hex(16)
      const message = `Sign in to Zecca\nAddress: ${address}\nNonce: ${nonce}`
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
      data.nonces[nonce] = { address, publicKey, message, expiresAt }
      return { nonce, message, expiresAt }
    },
    takeNonce(nonce: string) {
      const n = data.nonces[nonce]
      delete data.nonces[nonce]
      if (!n || Date.parse(n.expiresAt) < Date.now()) fail(401, 'unauthorized', 'That sign-in link has expired. Try again.')
      return n!
    },
    openSession(address: string, publicKey: string) {
      const token = 'mock_' + hex(24).toLowerCase()
      data.sessions[token] = { address, publicKey }
      save()
      return { token, user: userByAddress(address) }
    },

    // ---------- directory ----------
    handleTaken(handle: string) {
      return Object.values(data.users).some((u) => u.handle === handle)
    },
    resolve(q: string) {
      const s = q.trim().replace(/^@/, '').toLowerCase()
      const u = Object.values(data.users).find((x) => x.handle === s || x.email?.toLowerCase() === s || x.phone === q.trim() || x.address === q.trim())
      if (u) return { kind: 'zecca' as const, profile: profileOf(u) }
      if (/^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(q.trim())) return { kind: 'external' as const, address: q.trim() }
      return { kind: 'unknown' as const }
    },
    contacts(u: User) {
      const ids = new Set<string>()
      for (const a of data.activity[u.id] ?? []) if (a.counterparty) ids.add(a.counterparty.id)
      const known = [...ids].map((id) => data.users[id]).filter(Boolean)
      // A fresh account still sees the demo people, so Send has somewhere to start.
      const demo = ['usr_carla', 'usr_bruno'].map((id) => data.users[id]).filter((x) => x && !ids.has(x.id) && x.id !== u.id)
      return [...known, ...demo].map(profileOf)
    },

    // ---------- onboarding and submit ----------
    prepareOnboarding(token: string, b: { address: string; publicKey: string; handle: string; displayName: string; role: Role; businessName?: string; email?: string }) {
      const s = sessionOf(token)
      if (s.address !== b.address) fail(403, 'forbidden', 'This session belongs to another account.')
      if (userByAddress(b.address)) fail(409, 'already_signed_up', 'This account is already set up.')
      if (this.handleTaken(b.handle)) fail(409, 'handle_taken', 'Taken, try another.')
      if (b.role === 'merchant' && !b.businessName) fail(400, 'bad_request', 'Add your business name.')
      data.seq += 1
      const tx = { ...fx.preparedOnboarding.tx, Account: b.address, SigningPubKey: b.publicKey, Sequence: data.seq, LastLedgerSequence: data.seq + DEFAULTS.LLS_WINDOW }
      const p = prepare(token, 'onboarding', tx, { kind: 'onboarding', ...b })
      save()
      return p
    },
    /** Called after the handler checked the blob against the prepared tx and its signature. */
    async completeSubmit(token: string, prepareId: string, hash: string) {
      const row = data.prepared[prepareId]
      row.used = true
      await sleep(delays.submitMs)
      if (row.pending.kind === 'onboarding') {
        const p = row.pending
        const user: User = {
          id: randomId('usr'),
          role: p.role === 'merchant' ? ['user', 'merchant'] : ['user'],
          handle: p.handle,
          displayName: p.displayName,
          address: p.address,
          ...(p.email ? { email: p.email } : {}),
          tier: 0,
          createdAt: now(),
          ...(p.role === 'merchant' ? { merchant: { businessName: p.businessName!, feeBps: config.fees.merchantFeeBps } } : {}),
        }
        data.users[user.id] = user
        data.balances[user.id] = { availableMinor: 0, pendingMinor: 0, updatedAt: now() }
        data.activity[user.id] = []
        // Re-key listeners opened before sign-up (keyed by address) to the new user id.
        const early = listeners.get(p.address)
        if (early) {
          listeners.set(user.id, early)
          listeners.delete(p.address)
        }
        if (config.welcomeCreditMinor > 0) {
          const i = createIntent('p2p', user, user, config.welcomeCreditMinor, 0, { fromUserId: 'usr_zecca', status: 'paid_out', depositTxHash: hash, note: 'Demo credit' })
          data.balances[user.id].availableMinor = config.welcomeCreditMinor
          data.activity[user.id].unshift({ id: randomId('act'), intentId: i.id, direction: 'in', kind: 'welcome', amountMinor: config.welcomeCreditMinor, feeMinor: 0, status: 'done', note: 'Demo credit', at: now(), ledger: { depositTxHash: hash, network: 'devnet' } })
        }
        save()
        return { status: 'validated' as const, hash, engineResult: 'tesSUCCESS', user }
      }
      if (row.pending.kind === 'credential_accept') {
        // The credential is accepted: the account is verified (tier 1), as the API does after the ledger confirms it.
        const u = userOf(token)
        u.tier = 1
        const check = data.identity?.[row.pending.sessionId]
        if (check) check.accepted = true
        save()
        return { status: 'validated' as const, hash, engineResult: 'tesSUCCESS', user: { ...u } }
      }
      const i = data.intents[row.pending.intentId]
      setIntent(i, { status: 'submitted', depositTxHash: hash })
      afterDeposit(i)
      save()
      return { status: 'validated' as const, hash, engineResult: 'tesSUCCESS', intent: { ...i } }
    },
    preparedRow(prepareId: string) {
      return data.prepared[prepareId]
    },

    // ---------- money ----------
    activityPage(u: User, cursor?: string, limit = 20) {
      const all = data.activity[u.id] ?? []
      const start = cursor ? Number(cursor) : 0
      const items = all.slice(start, start + limit)
      return { items, ...(start + limit < all.length ? { nextCursor: String(start + limit) } : {}) }
    },
    activityOne(u: User, id: string) {
      const a = (data.activity[u.id] ?? []).find((x) => x.id === id || x.intentId === id)
      if (!a) fail(404, 'not_found', "We couldn't find that payment.")
      return a!
    },
    createTransfer(token: string, to: string, amountMinor: number, note?: string) {
      const u = userOf(token)
      const dest = data.users[to]
      if (!dest) fail(404, 'not_found', "We couldn't find that person.")
      if (dest.id === u.id) fail(400, 'bad_request', "You can't send money to yourself.")
      checkLimits(u, amountMinor)
      const i = createIntent('p2p', u, dest, amountMinor, 0, note ? { note } : {})
      const s = sessionOf(token)
      const prepared = prepare(token, 'send', sendTx(u.address, s.publicKey), { kind: 'send', intentId: i.id })
      save()
      return { intent: { ...i }, prepared }
    },
    intent(token: string, id: string) {
      const u = userOf(token)
      const i = data.intents[id]
      if (!i || (i.fromUserId !== u.id && i.toUserId !== u.id)) fail(404, 'not_found', "We couldn't find that payment.")
      return { ...i }
    },
    createRequest(token: string, amountMinor: number, reference?: string) {
      const u = userOf(token)
      if (!u.role.includes('merchant')) fail(403, 'forbidden', 'Switch on your business account to charge customers.')
      const id = randomId('pr')
      const pr: PaymentRequest = {
        id,
        merchantId: u.id,
        merchantName: u.merchant?.businessName ?? u.displayName,
        amountMinor,
        ...(reference ? { reference } : {}),
        status: 'created',
        url: `${config.webOrigin}/pay/${id}`,
        expiresAt: new Date(Date.now() + DEFAULTS.PAYMENT_REQUEST_TTL_SECONDS * 1000).toISOString(),
      }
      data.paymentRequests[id] = pr
      save()
      return pr
    },
    readRequest(id: string, token: string | null) {
      expireRequests()
      const pr = data.paymentRequests[id]
      if (!pr) fail(404, 'not_found', "We couldn't find this payment request.")
      const viewer = token && data.sessions[token] ? userByAddress(data.sessions[token].address) : undefined
      if (pr.status === 'created' && viewer?.id !== pr.merchantId) setRequest(pr, { status: 'opened' })
      save()
      return { ...pr }
    },
    payRequest(token: string, id: string) {
      const u = userOf(token)
      expireRequests()
      const pr = data.paymentRequests[id]
      if (!pr) fail(404, 'not_found', "We couldn't find this payment request.")
      if (pr.status === 'paid' || Object.values(data.intents).some((i) => i.paymentRequestId === id && i.status !== 'failed' && i.status !== 'expired' && i.status !== 'created'))
        fail(409, 'already_paid', 'This request has already been paid.')
      if (pr.status === 'expired') fail(410, 'expired', 'This request has expired. Ask the merchant for a new one.')
      if (pr.status === 'cancelled') fail(410, 'expired', 'The merchant cancelled this request. Ask them for a new one.')
      if (pr.merchantId === u.id) fail(400, 'bad_request', "You can't pay your own request.")
      checkLimits(u, pr.amountMinor)
      const merchant = data.users[pr.merchantId]
      const fee = feeOf(pr.amountMinor, merchant?.merchant?.feeBps ?? config.fees.merchantFeeBps)
      const i = createIntent('merchant', u, merchant, pr.amountMinor, fee, { paymentRequestId: id, ...(pr.reference ? { note: pr.reference } : {}) })
      const prepared = prepare(token, 'send', sendTx(u.address, sessionOf(token).publicKey), { kind: 'send', intentId: i.id })
      save()
      return { intent: { ...i }, prepared }
    },
    cancelRequest(token: string, id: string) {
      const u = userOf(token)
      const pr = data.paymentRequests[id]
      if (!pr || pr.merchantId !== u.id) fail(404, 'not_found', "We couldn't find this payment request.")
      if (pr.status === 'paid') fail(409, 'already_paid', 'This request has already been paid.')
      setRequest(pr, { status: 'cancelled' })
      save()
      return { ...pr }
    },
    sales(token: string, from?: string, to?: string) {
      const u = userOf(token)
      if (!u.role.includes('merchant')) fail(403, 'forbidden', 'Switch on your business account to see sales.')
      const items = (data.sales[u.id] ?? []).filter((s) => (!from || s.paidAt >= from) && (!to || s.paidAt <= to))
      const totals = items.reduce((t, s) => ({ grossMinor: t.grossMinor + s.amountMinor, feeMinor: t.feeMinor + s.feeMinor, netMinor: t.netMinor + s.netMinor, count: t.count + 1 }), { grossMinor: 0, feeMinor: 0, netMinor: 0, count: 0 })
      return { items, totals }
    },
    credit,
    /** Dev helper: someone pays this user (runs the same received -> paid_out steps). For demos and screenshots. */
    demoIncoming(fromHandle: string, toHandle: string, amountMinor: number, note?: string) {
      const from = Object.values(data.users).find((u) => u.handle === fromHandle)
      const to = Object.values(data.users).find((u) => u.handle === toHandle)
      if (!from || !to) throw new Error('unknown handle')
      changeBalance(from.id, amountMinor)
      const i = createIntent('p2p', from, to, amountMinor, 0, { status: 'submitted', depositTxHash: hex(32), ...(note ? { note } : {}) })
      afterDeposit(i)
      save()
      return i
    },
    later,
    // ---------- identity (mock wallet: answers after delays.identityMs) ----------
    createIdentitySession(token: string) {
      const u = userOf(token)
      const id = randomId('idv')
      ;(data.identity ??= {})[id] = { userId: u.id, startedAt: Date.now() }
      save()
      return { ...fx.identitySession, id, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), mode: 'mock' as const }
    },
    identitySession(token: string, id: string) {
      const u = userOf(token)
      const check = data.identity?.[id]
      if (!check || check.userId !== u.id) return fail(404, 'not_found', 'This check has expired. Start again.')
      if (Date.now() - check.startedAt < delays.identityMs) return { status: 'pending' as const }
      const identity = fx.identityVerified.identity!
      if (check.accepted || u.tier === 1) return { status: 'verified' as const, identity, message: 'Your identity is already verified.' }
      const held = check.prepareId ? data.prepared[check.prepareId] : undefined
      if (held?.used) return { status: 'verified' as const, identity, message: 'Your approval is being confirmed.' }
      if (held && Date.parse(held.prepared.expiresAt) > Date.now()) return { status: 'verified' as const, identity, prepared: held.prepared }
      const s = sessionOf(token)
      data.seq += 1
      const tx = {
        TransactionType: 'CredentialAccept',
        Account: u.address,
        Issuer: fx.ADDR.issuer,
        CredentialType: CREDENTIAL_TYPE,
        Fee: '12',
        Sequence: data.seq,
        LastLedgerSequence: data.seq + DEFAULTS.LLS_WINDOW,
        SigningPubKey: s.publicKey,
      }
      const prepared = prepare(token, 'credential_accept', tx, { kind: 'credential_accept', sessionId: id })
      check.prepareId = prepared.prepareId
      save()
      return { status: 'verified' as const, identity, prepared }
    },
    card: () => data.card,
    setCard(state: 'OPEN' | 'PAUSED' | 'CLOSED') {
      data.card = { state }
      save()
    },
  }
}
