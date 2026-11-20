// Ramp connector (MoonPay sandbox, SPEC §4.5), ported from ../moonpay-ramp: the widget session and URL signing, the signed
// webhook, and a Testnet watcher as a second trigger. A buy is credited only after the delivery is confirmed on the Testnet
// ledger (validated, tesSUCCESS, our treasury, Ripple's testnet RLUSD), for the DELIVERED amount (D5) times
// RAMP_SANDBOX_SCALE, then through SPEC §2.7: the issuer mints that amount into the pool (reference = the delivery hash) and
// the pool pays it out like any payout. One credit per MoonPay transaction and per delivery hash, whatever the trigger.
import type { Context, Hono } from 'hono'
import { formatUsd } from '@zecca/contracts'
import type { Core } from '../../core'
import { publicConfig } from '../../config'
import { ApiErr, Err } from '../../errors'
import { mount } from '../../http'
import { addActivity, emitActivity } from '../../books'
import { applyReceived, emitIntent } from '../../intents/flow'
import { intents, ZECCA } from '../../intents/repo'
import { checkIncoming } from '../../limits'
import { users, type UserRow } from '../../users'
import { createMoonPayApi, ipHash, redactUrl, signQuery, signedWidgetUrl, verifyWebhookSignature, type MoonPayApi, type MoonPayCurrency } from './moonpay'
import { checkDelivery, creditMinor, type DeliveredCurrency, type DeliveryCheck } from './delivery'
import { ensureRampTables, rampCredits, rampSessions, type RampSession } from './store'
import { createLiveTestnetReader, type TestnetReader } from './testnet'

export type RampDeps = {
  /** MoonPay's public API (default: the real one with MOONPAY_PUBLISHABLE_KEY). */
  moonpay?: MoonPayApi
  /** XRPL Testnet reads (default: a live client on the public Testnet endpoint). */
  testnet?: TestnetReader
  /** How often the watcher looks up open sessions at MoonPay, in ms (default 15000; 0 = only on treasury events). */
  pollMs?: number
}

const PRIMARY = 'rlusd_xrp'
const FALLBACK = 'xrp'
const DELIVERED: Record<string, DeliveredCurrency> = { rlusd_xrp: 'RLUSD', xrp: 'XRP' }
/** Sessions the watcher keeps asking MoonPay about. */
const OPEN_WINDOW_MS = 2 * 3_600_000
const OPEN_MAX = 25

const COPY = {
  unavailable: 'Top-up is not available right now.',
  region: "Top-up isn't available in your country yet.",
  badLink: 'This top-up link is not valid. Start again.',
  signature: 'Signature check failed.',
  refusedLimit: (cap: number) =>
    `We received your payment but couldn't add it: unverified accounts can hold up to ${formatUsd(cap)}. Our team has been told and will sort it out.`,
  mintFailed: "We received your payment but couldn't add it yet. Our team has been told and will sort it out.",
}
const unavailable = () => new ApiErr(503, 'upstream_error', COPY.unavailable)

const PRIVATE_IP = /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd|fe80:|localhost$)/i
/** The browser's public IP, or undefined on a private network (MoonPay then uses our own public IP, which a local browser shares). */
function clientIp(c: Context): string | undefined {
  const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
  const ip = (c.req.header('cf-connecting-ip') ?? fwd ?? c.req.header('x-real-ip') ?? socket)?.replace(/^::ffff:/i, '')
  return !ip || PRIVATE_IP.test(ip) ? undefined : ip
}

type Outcome = 'ignored' | 'waiting' | 'duplicate' | 'rejected' | 'refused' | 'credited'

export function mountRamp(app: Hono, core: Core, deps: RampDeps = {}): void {
  ensureRampTables(core.db)
  const env = core.env
  const scale = publicConfig(env).rampSandboxScale
  const sandbox = scale !== 1
  const keys = () => {
    const publishableKey = env.MOONPAY_PUBLISHABLE_KEY
    const secretKey = env.MOONPAY_SECRET_KEY
    return publishableKey && secretKey ? { publishableKey, secretKey } : undefined
  }
  const treasury = () => (core.keystore.hasWallet('testnetTreasury') ? core.keystore.getWallet('testnetTreasury').address : undefined)
  let moonpay = deps.moonpay
  let testnet = deps.testnet
  const mp = () => (moonpay ??= createMoonPayApi({ publishableKey: keys()!.publishableKey }))
  const ledger = () => (testnet ??= createLiveTestnetReader({ log: (m) => core.log.warn(m) }))

  /** Everything a session needs, or 503. */
  function ready(): { keys: { publishableKey: string; secretKey: string }; treasury: string } {
    const k = keys()
    const t = treasury()
    if (!k || !t) {
      core.log.error(`[ramp] top-up unavailable: ${!k ? 'MOONPAY_PUBLISHABLE_KEY / MOONPAY_SECRET_KEY not set' : "no 'testnetTreasury' wallet in the key store (npm run bootstrap)"}`)
      throw unavailable()
    }
    return { keys: k, treasury: t }
  }

  // ---------- session ----------
  async function pickCurrency(country: string | undefined): Promise<string> {
    // RLUSD is in MoonPay's notAllowedCountries for the EU/EEA (and absent from the list there): use XRP on Testnet instead.
    const rl = await mp()
      .currency(PRIMARY)
      .catch((e) => {
        core.log.warn(`[ramp] currency list: ${(e as Error).message}`)
        return { code: PRIMARY } as MoonPayCurrency
      })
    const blocked = !rl || rl.isSuspended === true || (!!country && (rl.notAllowedCountries ?? []).includes(country))
    return blocked ? FALLBACK : PRIMARY
  }

  mount(app, core, 'rampSession', async ({ c, user, body }) => {
    if (body.direction !== 'buy') throw Err.featureOff() // sell (withdraw) is not built: SPEC §4.5, FEATURE_WITHDRAW stays off
    const r = ready()
    const u = user!
    const fiatCurrency = (body.fiatCurrency ?? 'usd').toLowerCase()
    const fiatAmount = body.fiatAmount ?? 50
    // A dollar purchase is at most its fiat amount once delivered (fees come off): refuse before payment what the cap would refuse after.
    if (fiatCurrency === 'usd') checkIncoming(core, u, Math.ceil(fiatAmount * 100), 'self')
    const where = await mp()
      .ipCountry(clientIp(c))
      .catch(() => null)
    const ip = where?.status === 200 ? (where.body?.ipAddress as string | undefined) : undefined
    if (!ip) {
      core.log.error(`[ramp] MoonPay ip_address lookup failed: ${where?.status ?? 'network'}`)
      throw unavailable()
    }
    if (where!.body.isBuyAllowed === false) throw new ApiErr(503, 'upstream_error', COPY.region)
    const currencyCode = await pickCurrency(where!.body.alpha2)
    const allowedIpAddress = ipHash(r.keys.secretKey, ip)
    const externalId = core.id('ramp')
    rampSessions.insert(core.db, {
      externalId,
      userId: u.id,
      direction: 'buy',
      currencyCode,
      walletAddress: r.treasury,
      ipHash: allowedIpAddress,
      fiatAmount: String(fiatAmount),
      fiatCurrency,
      createdAt: core.iso(),
    })
    const params: Record<string, string> = {
      currencyCode,
      walletAddress: r.treasury,
      baseCurrencyCode: fiatCurrency,
      baseCurrencyAmount: String(fiatAmount),
      lockAmount: 'true', // the amount the tier-0 check passed: not changeable in the widget
      externalCustomerId: u.id,
      externalTransactionId: externalId,
      allowedIpAddress,
    }
    const widgetUrl = signedWidgetUrl(r.keys, 'buy', params)
    core.log.info(`[ramp] session ${externalId} @${u.handle} ${currencyCode} ${fiatAmount} ${fiatCurrency} ${redactUrl(widgetUrl)}`)
    startWatching()
    return { widgetUrl, externalId, params: { apiKey: r.keys.publishableKey, ...params }, sandbox }
  })

  // ---------- URL signing for the web SDK (generateUrlForSigning -> updateSignature) ----------
  function refuseToSign(url: URL, u: UserRow, r: ReturnType<typeof ready>): string | undefined {
    const q = url.searchParams
    if (url.protocol !== 'https:' || !/^buy(-sandbox)?\.moonpay\.com$/.test(url.hostname)) return `host ${url.host}`
    if (q.get('apiKey') !== r.keys.publishableKey) return 'apiKey mismatch'
    for (const k of ['walletAddresses', 'refundWalletAddress', 'refundWalletAddresses', 'quoteCurrencyAmount']) if (q.has(k)) return `${k} not allowed`
    const s = rampSessions.byExternalId(core.db, q.get('externalTransactionId'))
    if (!s || s.userId !== u.id) return 'externalTransactionId is not a session of this user'
    if (s.doneAt) return 'session already credited'
    if (q.get('baseCurrencyAmount') !== s.fiatAmount || q.get('baseCurrencyCode') !== s.fiatCurrency) return 'amount is not the session amount'
    if (q.get('lockAmount') !== 'true') return 'amount not locked'
    if (q.get('walletAddress') !== s.walletAddress) return 'walletAddress is not our treasury'
    if (q.get('allowedIpAddress') !== s.ipHash) return 'allowedIpAddress was not issued for this session'
    if (q.has('currencyCode') && !Object.hasOwn(DELIVERED, q.get('currencyCode')!)) return `currency ${q.get('currencyCode')}`
    return undefined
  }

  mount(app, core, 'rampSign', ({ user, body }) => {
    const r = ready()
    const url = new URL(body.url)
    const why = refuseToSign(url, user!, r)
    if (why) {
      core.log.warn(`[ramp] refused to sign a widget URL for @${user!.handle}: ${why}`)
      throw Err.badRequest(COPY.badLink)
    }
    url.searchParams.delete('signature')
    return { signature: signQuery(r.keys.secretKey, url.search) }
  })

  // ---------- webhook ----------
  mount(app, core, 'moonpayWebhook', async ({ c }) => {
    if (!core.settings.features.ramp) throw Err.featureOff()
    const raw = await c.req.text()
    const v = verifyWebhookSignature(raw, c.req.header('moonpay-signature-v2'), env.MOONPAY_WEBHOOK_KEY, { nowMs: core.now() })
    if (!v.ok) {
      core.log.warn(`[ramp] webhook refused: ${v.reason}`)
      throw Err.unauthorized(COPY.signature)
    }
    let body: { type?: string; data?: unknown } | null = null
    try {
      body = JSON.parse(raw)
    } catch {
      throw Err.badRequest('The request body must be JSON.')
    }
    core.log.info(`[ramp] webhook ${body?.type} ${(body?.data as { status?: string })?.status ?? ''}`)
    // Buy events only (MoonPay never sent transaction_created; the first one is transaction_updated / pending).
    if (body?.type && /^transaction_/.test(body.type) && body.data) core.track(handle(body.data, 'webhook'), 'ramp webhook')
    return { ok: true as const }
  })

  // ---------- credit ----------
  const inflight = new Set<string>()
  const minting = new Set<string>()

  function reject(tx: any, s: RampSession, hash: string, reason: string, source: string): Outcome {
    rampCredits.insert(core.db, { moonpayTxId: String(tx.id), deliveryHash: hash, externalId: s.externalId, userId: s.userId, status: 'rejected', reason, source }, core.iso())
    core.log.error(`[ramp] NOT credited: MoonPay ${tx.id} delivery ${hash} for session ${s.externalId}: ${reason}`)
    return 'rejected'
  }

  /** One MoonPay buy transaction (from a signed webhook or MoonPay's API): credit it once, if the ledger agrees. */
  async function handle(tx: any, source: 'webhook' | 'watcher'): Promise<Outcome> {
    if (!tx || typeof tx !== 'object' || typeof tx.id !== 'string') return 'ignored'
    const s = rampSessions.byExternalId(core.db, tx.externalTransactionId)
    if (!s) return 'ignored' // not one of ours
    if (tx.status === 'failed') {
      core.log.warn(`[ramp] MoonPay ${tx.id} for ${s.externalId} failed: ${tx.failureReason ?? 'no reason given'}`)
      return 'ignored'
    }
    if (tx.walletAddress !== s.walletAddress) {
      core.log.error(`[ramp] MoonPay ${tx.id} for ${s.externalId} delivers to ${tx.walletAddress}, not our treasury: ignored`)
      return 'ignored'
    }
    const raw = tx.cryptoTransactionId
    if (typeof raw !== 'string' || !/^[0-9A-Fa-f]{64}$/.test(raw)) return 'waiting'
    const hash = raw.toUpperCase()
    if (rampCredits.byMoonPayId(core.db, tx.id) || rampCredits.byHash(core.db, hash)) return 'duplicate'
    if (inflight.has(tx.id) || inflight.has(hash)) return 'duplicate'
    inflight.add(tx.id).add(hash)
    try {
      const code = String(tx.currency?.code ?? '')
      const currency = Object.hasOwn(DELIVERED, code) ? DELIVERED[code] : undefined
      if (!currency) return reject(tx, s, hash, `unexpected currency ${tx.currency?.code}`, source)
      let check: DeliveryCheck
      try {
        check = checkDelivery(await ledger().tx(hash), { hash, treasury: s.walletAddress, currency })
      } catch (e) {
        core.log.warn(`[ramp] Testnet lookup of ${hash} failed: ${(e as Error).message} (retried by the watcher)`)
        return 'waiting'
      }
      if (!check.ok) return check.final ? reject(tx, s, hash, check.reason, source) : 'waiting'
      let amountMinor: number
      try {
        amountMinor = creditMinor(check, scale, tx)
      } catch (e) {
        return reject(tx, s, hash, (e as Error).message, source)
      }
      if (amountMinor <= 0) return reject(tx, s, hash, `delivered ${check.value} ${check.currency} is less than a cent`, source)
      return credit(tx, s, hash, check, amountMinor, source)
    } finally {
      inflight.delete(tx.id)
      inflight.delete(hash)
    }
  }

  /** Records the credit and opens the top-up intent (network testnet, deposit = the delivery), or refuses it at the tier-0 cap. */
  function credit(tx: any, s: RampSession, hash: string, check: Extract<DeliveryCheck, { ok: true }>, amountMinor: number, source: string): Outcome {
    const user = users.byId(core, s.userId)
    if (!user || user.status !== 'active') return reject(tx, s, hash, 'user is not active', source)
    const note = sandbox ? 'Sandbox' : undefined
    const intentId = core.id('int')
    let outcome = 'duplicate' as Outcome
    let activityId: string | undefined
    let refusedCap = 0
    core.db.transaction(() => {
      const at = core.iso()
      const row = { moonpayTxId: tx.id as string, deliveryHash: hash, externalId: s.externalId, userId: user.id, currency: check.currency, delivered: check.value, amountMinor, source }
      if (!rampCredits.insert(core.db, { ...row, status: 'credited' }, at)) return
      rampSessions.markDone(core.db, s.externalId, at)
      try {
        checkIncoming(core, user, amountMinor, 'self')
      } catch (e) {
        if (!(e instanceof ApiErr) || e.code !== 'limit_reached') throw e
        refusedCap = e.details?.capMinor ?? core.settings.tier0.balanceCapMinor
        const failure = { code: 'limit_reached', message: COPY.refusedLimit(refusedCap) }
        intents.insert(core, { id: intentId, kind: 'topup', status: 'failed', fromUserId: ZECCA, toUserId: user.id, amountMinor, feeMinor: 0, note, network: 'testnet', depositTxHash: hash, reference: hash, failure })
        activityId = addActivity(core, { userId: user.id, intentId, direction: 'in', kind: 'topup', amountMinor, feeMinor: 0, note })
        rampCredits.patch(core.db, row.moonpayTxId, { status: 'refused_limit', intentId, reason: `tier-0 balance cap ${refusedCap}` }, at)
        outcome = 'refused'
        return
      }
      // reference = the delivery hash: the API's top-up recovery (jobs tick, runTopup) mints a created top-up with its reference
      // too, so whichever runs, the pool worker mints this delivery once.
      intents.insert(core, { id: intentId, kind: 'topup', status: 'created', fromUserId: ZECCA, toUserId: user.id, amountMinor, feeMinor: 0, note, network: 'testnet', depositTxHash: hash, reference: hash })
      rampCredits.patch(core.db, row.moonpayTxId, { intentId }, at)
      outcome = 'credited'
    })()
    if (outcome === 'refused') {
      core.log.error(`[ramp] NOT credited (tier-0 cap ${refusedCap}): ${amountMinor} for @${user.handle}, MoonPay ${tx.id}, delivery ${hash}; the money is on the Testnet treasury`)
      emitIntent(core, intentId)
      emitActivity(core, activityId)
    } else if (outcome === 'credited') {
      core.log.info(`[ramp] credit ${amountMinor} to @${user.handle} for ${check.value} ${check.currency} delivered in ${hash} (${source})`)
      core.track(mint(intentId), 'ramp mint')
    }
    return outcome
  }

  /** SPEC §2.7: mint into the pool with the delivery hash as reference (idempotent in the pool worker), then the usual payout. */
  async function mint(intentId: string): Promise<void> {
    if (minting.has(intentId)) return
    minting.add(intentId)
    try {
      const i = intents.byId(core, intentId)
      if (!i || i.status !== 'created' || !i.depositTxHash) return
      const c = rampCredits.byHash(core.db, i.depositTxHash)!
      let mintHash: string
      try {
        mintHash = (await core.pool.mintIn(i.amountMinor, i.depositTxHash)).hash
      } catch (e) {
        core.log.error(`[ramp] mint for ${intentId} (delivery ${i.depositTxHash}) failed: ${(e as Error).message}; retry by hand`)
        let actId: string | undefined
        core.db.transaction(() => {
          if (!intents.transition(core, intentId, 'created', 'failed', { failure: { code: 'mint_failed', message: COPY.mintFailed } })) return
          rampCredits.patch(core.db, c.moonpayTxId, { status: 'mint_failed', reason: (e as Error).message }, core.iso())
          actId = addActivity(core, { userId: i.toUserId!, intentId, direction: 'in', kind: 'topup', amountMinor: i.amountMinor, feeMinor: 0, note: i.note })
        })()
        emitIntent(core, intentId)
        emitActivity(core, actId)
        return
      }
      rampCredits.patch(core.db, c.moonpayTxId, { mintHash }, core.iso())
      if (!intents.transition(core, intentId, 'created', 'submitted', { submittedAt: core.iso() })) return
      emitIntent(core, intentId)
      applyReceived(core, intentId)
    } finally {
      minting.delete(intentId)
    }
  }

  // ---------- watcher: treasury events + a poll, both asking MoonPay about our open sessions ----------
  let watching = false
  let scanning: Promise<void> | null = null
  let again = false

  async function scanOnce(): Promise<void> {
    // Credits recorded before a restart whose mint never ran (mintIn is idempotent by reference).
    for (const c of rampCredits.withStatus(core.db, 'credited')) if (c.intentId && intents.byId(core, c.intentId)?.status === 'created') await mint(c.intentId)
    for (const s of rampSessions.open(core.db, core.iso(core.now() - OPEN_WINDOW_MS), OPEN_MAX)) {
      const r = await mp()
        .buyTransactionsByExternalId(s.externalId)
        .catch(() => null)
      if (r?.status !== 200 || !Array.isArray(r.body)) continue // 404: no purchase yet
      for (const tx of r.body) await handle(tx, 'watcher')
    }
  }

  function scan(): Promise<void> {
    if (scanning) {
      again = true
      return scanning
    }
    scanning = (async () => {
      try {
        do {
          again = false
          await scanOnce()
        } while (again)
      } catch (e) {
        core.log.warn(`[ramp] scan: ${(e as Error).message}`)
      } finally {
        scanning = null
      }
    })()
    return scanning
  }

  function startWatching(): void {
    if (watching || !core.settings.features.ramp || !keys()) return
    const t = treasury()
    if (!t) return
    watching = true
    ledger().watch(t, () => core.track(scan(), 'ramp scan'))
    const pollMs = deps.pollMs ?? 15_000
    if (pollMs > 0) setInterval(() => core.track(scan(), 'ramp scan'), pollMs).unref()
    core.log.info(`[ramp] watching the Testnet treasury ${t} (poll ${pollMs} ms)`)
  }

  startWatching()
}
