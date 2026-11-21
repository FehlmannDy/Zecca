// Withdrawal to a card through MoonPay sell (SPEC §4.5), behind FEATURE_WITHDRAW. Never run against MoonPay end to end yet.
//   1. POST /v1/ramp/session { direction: 'sell' }: a signed sell widget (refunds go to our Testnet treasury), bound to the user.
//   2. The widget's onInitiateDeposit -> POST /v1/ramp/sell/deposit: we re-read the sale from MoonPay (never the browser's
//      amounts), price it in cents (RLUSD 1:1, XRP at MoonPay's rate), and open a 'withdraw' intent: the user's confidential
//      deposit to the pool (prepared kind 'send', like a card load), approved in the app.
//   3. When the pool confirms it ('received'), the Testnet treasury pays MoonPay's deposit wallet the crypto amount, once:
//      the payment's hash is stored before it is submitted. A payment that fails gives the dollars back through the pool.
//   4. MoonPay's status (signed sell_transaction_* webhooks, and a poll) moves it to "Paid out to your card".
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { formatUsd, type Intent, type PreparedTx } from '@zecca/contracts'
import { OUTCOME_UNKNOWN } from '@zecca/xrpl-core'
import type { Core } from '../../core'
import { ApiErr, Err } from '../../errors'
import { zodMessage } from '../../http'
import { lookupSession } from '../../auth/sessions'
import { claimEffect, getBalance } from '../../books'
import { applyReceived, ciphertextPreviewOf, emitIntent } from '../../intents/flow'
import { intents, toIntent, ZECCA } from '../../intents/repo'
import { checkOutgoing } from '../../limits'
import { storePrepared } from '../../prepared/store'
import type { UserRow } from '../../users'
import { ipHash, redactUrl, signedWidgetUrl, type MoonPayApi, type MoonPayKeys } from './moonpay'
import { rampSessions } from './store'
import { checkSellTx, debitMinor, MIN_SELL_USD, paymentAmount, resolveDestination, type SellCheck, type TreasuryAmount } from './sell'
import { ensureSellTables, sellTxs, withdrawals, type Withdrawal } from './sell-store'
import type { TreasuryPayer } from './treasury'

export const SELL_COPY = {
  unavailable: 'Withdrawals are not available right now.',
  region: "Withdrawals aren't available in your country yet.",
  minimum: `Withdrawals start at ${formatUsd(MIN_SELL_USD * 100)}.`,
  dollars: 'Withdrawals are in dollars.',
  badLink: 'This withdrawal is not valid. Start again.',
  already: 'This withdrawal is already on its way.',
  notWaiting: 'MoonPay is no longer waiting for this withdrawal. Start again.',
  refunded: "This withdrawal didn't go through. The money is back in your balance.",
  moonpayFailed: "MoonPay couldn't pay this out. Our team has been told and will return your money.",
  replaced: 'Replaced by a new approval.',
}

/** What the withdraw screen shows. */
export type WithdrawalView = {
  id: string
  status: 'approve' | 'sending' | 'sent' | 'paid_out' | 'failed'
  amountMinor: number
  refunded: boolean
  message?: string
  moonpayStatus?: string
  sandbox: true
  createdAt: string
}

export type SellCtx = {
  core: Core
  keys(): MoonPayKeys | undefined
  treasuryAddress(): string | undefined
  mp(): MoonPayApi
  treasury(): TreasuryPayer
  clientIp(c: Context): string | undefined
  pickCurrency(country: string | undefined): Promise<string>
}

const DepositBody = z.object({
  externalId: z.string().min(1).max(100),
  transactionId: z.string().min(1).max(100),
  depositWalletAddress: z.string().max(100).optional(),
  depositWalletAddressTag: z.union([z.string().max(20), z.number().int(), z.null()]).optional(),
})

export function createWithdraw(ctx: SellCtx) {
  const { core } = ctx
  ensureSellTables(core.db)
  const unavailable = () => new ApiErr(503, 'upstream_error', SELL_COPY.unavailable)
  const on = () => core.settings.features.ramp && core.settings.features.withdraw

  function ready(): { keys: MoonPayKeys; treasury: string } {
    const keys = ctx.keys()
    const treasury = ctx.treasuryAddress()
    if (!keys || !treasury) {
      core.log.error(`[ramp/sell] withdrawals unavailable: ${!keys ? 'MOONPAY_PUBLISHABLE_KEY / MOONPAY_SECRET_KEY not set' : "no 'testnetTreasury' wallet in the key store"}`)
      throw unavailable()
    }
    return { keys, treasury }
  }

  function canAfford(u: UserRow, amountMinor: number): void {
    checkOutgoing(core, u, undefined, amountMinor, 0)
    const b = getBalance(core, u.id)
    if (b.availableMinor < amountMinor) throw Err.insufficient(amountMinor - b.availableMinor)
  }

  // ---------- 1. the sell widget session ----------
  async function session(c: Context, u: UserRow, body: { fiatAmount?: number; fiatCurrency?: string }) {
    if (!on()) throw Err.featureOff()
    const r = ready()
    const fiatCurrency = (body.fiatCurrency ?? 'usd').toLowerCase()
    if (fiatCurrency !== 'usd') throw Err.badRequest(SELL_COPY.dollars)
    const fiatAmount = body.fiatAmount ?? 25
    // MoonPay takes a whole fiat amount (quoteCurrencyAmount is an integer).
    if (!Number.isInteger(fiatAmount) || fiatAmount < MIN_SELL_USD) throw Err.badRequest(SELL_COPY.minimum)
    canAfford(u, fiatAmount * 100) // early: the real check runs on MoonPay's amount at the deposit
    const where = await ctx
      .mp()
      .ipCountry(ctx.clientIp(c))
      .catch(() => null)
    const ip = where?.status === 200 ? (where.body?.ipAddress as string | undefined) : undefined
    if (!ip) {
      core.log.error(`[ramp/sell] MoonPay ip_address lookup failed: ${where?.status ?? 'network'}`)
      throw unavailable()
    }
    if (where!.body.isSellAllowed === false) throw new ApiErr(503, 'upstream_error', SELL_COPY.region)
    const currencyCode = await ctx.pickCurrency(where!.body.alpha2)
    const allowedIpAddress = ipHash(r.keys.secretKey, ip)
    const externalId = core.id('ramp')
    rampSessions.insert(core.db, {
      externalId,
      userId: u.id,
      direction: 'sell',
      currencyCode,
      walletAddress: r.treasury, // the refund wallet: what MoonPay cannot sell comes back to the treasury
      ipHash: allowedIpAddress,
      fiatAmount: String(fiatAmount),
      fiatCurrency,
      createdAt: core.iso(),
    })
    const params: Record<string, string> = {
      baseCurrencyCode: currencyCode,
      quoteCurrencyCode: fiatCurrency,
      quoteCurrencyAmount: String(fiatAmount),
      refundWalletAddress: r.treasury,
      paymentMethod: 'credit_debit_card',
      externalCustomerId: u.id,
      externalTransactionId: externalId,
      allowedIpAddress,
    }
    const widgetUrl = signedWidgetUrl(r.keys, 'sell', params)
    core.log.info(`[ramp/sell] session ${externalId} @${u.handle} ${currencyCode} ${fiatAmount} ${fiatCurrency} ${redactUrl(widgetUrl)}`)
    return { widgetUrl, externalId, params: { apiKey: r.keys.publishableKey, ...params }, sandbox: true }
  }

  /** Why the web SDK's sell URL must not be signed, or undefined. */
  function refuseToSign(url: URL, u: UserRow): string | undefined {
    if (!on()) return 'withdrawals are off'
    const k = ctx.keys()
    if (!k) return 'no MoonPay keys'
    const q = url.searchParams
    if (url.protocol !== 'https:' || !/^sell(-sandbox)?\.moonpay\.com$/.test(url.hostname)) return `host ${url.host}`
    if (q.get('apiKey') !== k.publishableKey) return 'apiKey mismatch'
    for (const p of ['walletAddress', 'walletAddresses', 'refundWalletAddresses', 'baseCurrencyAmount', 'defaultBaseCurrencyCode']) if (q.has(p)) return `${p} not allowed`
    const s = rampSessions.byExternalId(core.db, q.get('externalTransactionId'))
    if (!s || s.userId !== u.id || s.direction !== 'sell') return 'externalTransactionId is not a sell session of this user'
    if (s.doneAt) return 'session already paid'
    if (q.get('baseCurrencyCode') !== s.currencyCode) return `currency ${q.get('baseCurrencyCode')}`
    if (q.get('quoteCurrencyCode') !== s.fiatCurrency || q.get('quoteCurrencyAmount') !== s.fiatAmount) return 'amount is not the session amount'
    if (q.get('refundWalletAddress') !== s.walletAddress) return 'refundWalletAddress is not our treasury'
    if (q.get('allowedIpAddress') !== s.ipHash) return 'allowedIpAddress was not issued for this session'
    return undefined
  }

  // ---------- 2. the deposit: MoonPay's sale -> a 'withdraw' intent ----------
  async function readSale(id: string): Promise<{ status: number; body: any } | null> {
    return ctx
      .mp()
      .getSellTransaction(id)
      .catch((e) => {
        core.log.warn(`[ramp/sell] MoonPay sell transaction ${id}: ${(e as Error).message}`)
        return null
      })
  }

  function record(tx: any, externalId: string, source: 'api' | 'webhook'): void {
    const c = checkSellTx(tx, { transactionId: String(tx?.id), externalId, currencyCode: String(tx?.baseCurrency?.code ?? '') })
    // Only a signed webhook or MoonPay's API reaches here: its deposit wallet is MoonPay's word.
    const wallet = c.ok ? c : { depositAddress: tx?.depositWallet?.walletAddress, depositTag: tx?.depositWallet?.walletAddressTag }
    const tag = wallet.depositTag
    sellTxs.record(
      core.db,
      {
        moonpayTxId: String(tx.id),
        externalId,
        ...(typeof tx.status === 'string' ? { status: tx.status } : {}),
        ...(typeof wallet.depositAddress === 'string' && wallet.depositAddress ? { depositAddress: wallet.depositAddress } : {}),
        ...(tag !== undefined && tag !== null && tag !== '' ? { depositTag: String(tag) } : {}),
      },
      core.iso(),
    )
    core.log.info(`[ramp/sell] MoonPay ${source}: sale ${tx.id} ${tx.status ?? ''}`)
  }

  async function deposit(u: UserRow, body: z.output<typeof DepositBody>): Promise<{ intent: Intent; prepared: PreparedTx; withdrawal: WithdrawalView }> {
    const r = ready()
    const s = rampSessions.byExternalId(core.db, body.externalId)
    if (!s || s.userId !== u.id || s.direction !== 'sell') throw Err.badRequest(SELL_COPY.badLink)
    if (s.doneAt) throw Err.conflict(SELL_COPY.already)
    const existing = withdrawals.byMoonPayId(core.db, body.transactionId)
    if (existing) {
      const ei = intents.byId(core, existing.intentId)
      if (existing.userId !== u.id) throw Err.badRequest(SELL_COPY.badLink)
      const neverSent = existing.status === 'awaiting_approval' && !!ei && (ei.status === 'failed' || ei.status === 'expired' || (ei.status === 'created' && !ei.submittedAt))
      if (!neverSent) throw Err.conflict(SELL_COPY.already)
    }
    const res = await readSale(body.transactionId)
    if (!res) throw unavailable()
    if (res.status === 404) throw Err.badRequest(SELL_COPY.badLink)
    if (res.status !== 200) {
      core.log.error(`[ramp/sell] MoonPay sell transaction ${body.transactionId}: ${res.status}`)
      throw unavailable()
    }
    const sale = checkSellTx(res.body, { transactionId: body.transactionId, externalId: s.externalId, currencyCode: s.currencyCode })
    if (!sale.ok) {
      core.log.warn(`[ramp/sell] refused the deposit for @${u.handle}: ${sale.reason}`)
      throw Err.badRequest(SELL_COPY.badLink)
    }
    record(res.body, s.externalId, 'api')
    if (sale.status !== 'waitingForDeposit') throw Err.conflict(SELL_COPY.notWaiting)
    const known = sellTxs.get(core.db, body.transactionId)
    const dest = resolveDestination(
      { moonpay: { address: sale.depositAddress ?? known?.depositAddress, tag: sale.depositTag ?? known?.depositTag }, widget: { address: body.depositWalletAddress, tag: body.depositWalletAddressTag } },
      r.treasury,
    )
    if (!dest.ok) {
      core.log.warn(`[ramp/sell] refused the deposit for @${u.handle}: ${dest.reason}`)
      throw Err.badRequest(SELL_COPY.badLink)
    }
    let amountMinor: number
    let amount: TreasuryAmount
    try {
      amountMinor = debitMinor(sale.currency, sale.cryptoAmount, sale.usdRate)
      amount = paymentAmount(sale.currency, sale.cryptoAmount)
    } catch (e) {
      core.log.warn(`[ramp/sell] refused the deposit for @${u.handle}: ${(e as Error).message}`)
      throw Err.badRequest(SELL_COPY.badLink)
    }
    canAfford(u, amountMinor)
    // Refuse now, not after the approval, what the treasury cannot pay.
    const can = await ctx
      .treasury()
      .canPay(amount)
      .catch((e) => {
        core.log.warn(`[ramp/sell] treasury balance read: ${(e as Error).message}`)
        throw unavailable()
      })
    if (!can) {
      core.log.error(`[ramp/sell] the Testnet treasury cannot pay ${sale.cryptoAmount} ${sale.currency} for @${u.handle}: top it up`)
      throw unavailable()
    }
    core.rateLimit(u.address)

    const intentId = core.id('int')
    core.db.transaction(() => {
      if (existing) {
        // The same sale again: the earlier approval was never sent. Close it, unless it is being sent right now.
        const closed = core.db
          .prepare("UPDATE intents SET status = 'failed', failure_code = 'replaced', failure_message = ?, updated_at = ? WHERE id = ? AND status = 'created' AND submitted_at IS NULL")
          .run(SELL_COPY.replaced, core.iso(), existing.intentId).changes
        const prev = intents.byId(core, existing.intentId)
        if (!closed && prev?.status !== 'failed' && prev?.status !== 'expired') throw Err.conflict(SELL_COPY.already)
      }
      intents.insert(core, { id: intentId, kind: 'withdraw', status: 'created', fromUserId: u.id, amountMinor, feeMinor: 0, note: 'To your card' })
      const row = {
        moonpayTxId: body.transactionId,
        intentId,
        externalId: s.externalId,
        userId: u.id,
        currency: sale.currency,
        cryptoAmount: sale.cryptoAmount,
        amountMinor,
        destination: dest.address,
        destinationSource: dest.source,
        ...(dest.tag !== undefined ? { destinationTag: dest.tag } : {}),
      }
      withdrawals.upsert(core.db, row, core.iso())
      if (withdrawals.byMoonPayId(core.db, body.transactionId)?.intentId !== intentId) throw Err.conflict(SELL_COPY.already)
    })()
    let prepared: PreparedTx
    try {
      const tx = () =>
        core.ledger.buildSend({
          from: u.address,
          to: core.keystore.getWallet('pool').address,
          amountMinor,
          senderKey: core.keystore.getElGamal({ user: u.address }),
          sponsored: true,
          publicKey: u.publicKey,
        })
      prepared = await storePrepared(core, { address: u.address, publicKey: u.publicKey, kind: 'send', tx, intentId })
      intents.patch(core, intentId, { prepareId: prepared.prepareId, ciphertextPreview: ciphertextPreviewOf(prepared.tx) })
    } catch (e) {
      core.log.error(`[ramp/sell] prepare ${intentId} failed: ${(e as Error).message}`)
      intents.transition(core, intentId, 'created', 'failed', { failure: { code: 'prepare_failed', message: "We couldn't prepare this. Try again." } })
      throw Err.ledger()
    }
    core.log.info(`[ramp/sell] withdrawal ${intentId} @${u.handle}: ${amountMinor} for ${sale.cryptoAmount} ${sale.currency} (sale ${body.transactionId}, address from ${dest.source})`)
    return { intent: toIntent(intents.byId(core, intentId)!), prepared, withdrawal: view(withdrawals.byIntent(core.db, intentId)!) }
  }

  function view(w: Withdrawal): WithdrawalView {
    const i = intents.byId(core, w.intentId)
    const base = { id: w.intentId, amountMinor: w.amountMinor, refunded: !!w.refundIntentId, sandbox: true as const, createdAt: w.createdAt, ...(w.moonpayStatus ? { moonpayStatus: w.moonpayStatus } : {}) }
    switch (w.status) {
      case 'awaiting_approval':
        if (i?.status === 'failed' || i?.status === 'expired') return { ...base, status: 'failed', ...(i.failure ? { message: i.failure.message } : {}) }
        return { ...base, status: i?.status === 'created' ? 'approve' : 'sending' }
      case 'paying':
      case 'sent':
        return { ...base, status: 'sending' }
      case 'delivered':
        return { ...base, status: 'sent' }
      case 'paid_out':
        return { ...base, status: 'paid_out' }
      case 'failed':
        return { ...base, status: 'failed', message: SELL_COPY.refunded }
      case 'moonpay_failed':
        return { ...base, status: 'failed', message: SELL_COPY.moonpayFailed }
    }
  }

  // ---------- 3. 'received': the treasury pays MoonPay, once ----------
  const running = new Set<string>()

  /** Pays (or settles the payment of) one received withdrawal. Safe to call again: the row's status and the stored hash decide. */
  async function pay(intentId: string): Promise<void> {
    if (running.has(intentId)) return
    running.add(intentId)
    try {
      const i = intents.byId(core, intentId)
      let w = withdrawals.byIntent(core.db, intentId)
      if (!w) return core.log.error(`[ramp/sell] ${intentId}: received, but no withdrawal recorded (money stays in the pool)`)
      if (!i || i.status !== 'received') return
      withdrawals.move(core.db, intentId, ['awaiting_approval'], 'paying', core.iso())
      w = withdrawals.byIntent(core.db, intentId)!
      if (w.status === 'sent') return await settleSent(w)
      if (w.status !== 'paying') return

      // MoonPay must still be waiting for this deposit, for the same amount, at the same address.
      const res = await readSale(w.moonpayTxId)
      if (!res || (res.status !== 200 && res.status !== 404)) return core.log.warn(`[ramp/sell] ${intentId}: MoonPay unreadable (${res?.status ?? 'network'}); paid on the next scan`)
      const sale: SellCheck =
        res.status === 404 ? { ok: false, reason: 'MoonPay does not know this sale' } : checkSellTx(res.body, { transactionId: w.moonpayTxId, externalId: w.externalId, currencyCode: currencyCodeOf(w) })
      if (sale.ok) record(res.body, w.externalId, 'api')
      const known = sellTxs.get(core.db, w.moonpayTxId)
      const why = !sale.ok
        ? sale.reason
        : sale.status !== 'waitingForDeposit'
          ? `MoonPay status ${sale.status}`
          : sale.currency !== w.currency || sale.cryptoAmount !== w.cryptoAmount
            ? `MoonPay now asks ${sale.cryptoAmount} ${sale.currency}, not ${w.cryptoAmount} ${w.currency}`
            : [sale.depositAddress, known?.depositAddress].some((a) => a && a !== w!.destination)
              ? 'MoonPay deposit address differs from the one approved'
              : undefined
      if (why) return refund(intentId, why)
      const confirmed = (sale.ok ? sale.depositAddress : undefined) ?? known?.depositAddress
      if (w.destinationSource === 'widget' && confirmed === w.destination) withdrawals.patch(core.db, intentId, { destinationSource: 'moonpay' }, core.iso())

      let result
      try {
        result = await ctx.treasury().pay({ destination: w.destination, tag: w.destinationTag, amount: paymentAmount(w.currency, w.cryptoAmount) }, (sgn) => {
          if (!withdrawals.markSent(core.db, intentId, sgn.hash, sgn.lastLedgerSequence, core.iso())) throw new Error('withdrawal is no longer waiting to be paid')
          rampSessions.markDone(core.db, w!.externalId, core.iso())
        })
      } catch (e) {
        const now = withdrawals.byIntent(core.db, intentId)!
        core.log.warn(`[ramp/sell] ${intentId}: treasury payment ${now.status === 'sent' ? `${now.payHash} outcome not known` : 'not sent'}: ${(e as Error).message}; the next scan settles it`)
        return
      }
      await finish(withdrawals.byIntent(core.db, intentId)!, result)
    } finally {
      running.delete(intentId)
    }
  }

  const currencyCodeOf = (w: Withdrawal) => rampSessions.byExternalId(core.db, w.externalId)?.currencyCode ?? ''

  async function finish(w: Withdrawal, r: { validated: boolean; engineResult: string; hash?: string }): Promise<void> {
    if (r.validated) {
      if (!withdrawals.move(core.db, w.intentId, ['sent'], 'delivered', core.iso())) return
      if (intents.transition(core, w.intentId, 'received', 'paid_out')) emitIntent(core, w.intentId)
      core.log.info(`[ramp/sell] ${w.intentId}: paid ${w.cryptoAmount} ${w.currency} to MoonPay in ${w.payHash} (Testnet)`)
      return
    }
    if (r.engineResult === OUTCOME_UNKNOWN) return core.log.warn(`[ramp/sell] ${w.intentId}: payment ${w.payHash} outcome not known yet; the next scan settles it`)
    return refund(w.intentId, `treasury payment ${w.payHash} failed: ${r.engineResult}`)
  }

  /** A payment signed and maybe submitted: its hash on the ledger decides (not found after its LastLedgerSequence = never applied). */
  async function settleSent(w: Withdrawal): Promise<void> {
    if (!w.payHash) return
    try {
      const r = await ctx.treasury().txResult(w.payHash)
      if (r?.validated) return await finish(w, r)
      if (r) return // pending
      const index = await ctx.treasury().ledgerIndex()
      if (w.payLls !== undefined && index > w.payLls) return refund(w.intentId, `treasury payment ${w.payHash} never reached the ledger`)
    } catch (e) {
      core.log.warn(`[ramp/sell] ${w.intentId}: Testnet lookup of ${w.payHash}: ${(e as Error).message}`)
    }
  }

  /** The payment to MoonPay did not happen: the dollars go back from the pool to the user, like a failed Earn deposit. Once. */
  function refund(intentId: string, reason: string): void {
    const w = withdrawals.byIntent(core.db, intentId)!
    const refundId = core.id('int')
    const created = core.db.transaction(() => {
      if (!withdrawals.move(core.db, intentId, ['paying', 'sent'], 'failed', core.iso(), { reason })) return false
      intents.transition(core, intentId, 'received', 'failed', { failure: { code: 'withdraw_failed', message: SELL_COPY.refunded } })
      if (!claimEffect(core, `${intentId}:withdraw_refund`)) return false
      // A credit from Zecca's pool like a top-up ('topup' has no received handler: the usual payout and merge settle it).
      intents.insert(core, { id: refundId, kind: 'topup', status: 'submitted', fromUserId: ZECCA, toUserId: w.userId, amountMinor: w.amountMinor, feeMinor: 0, note: 'Back from a withdrawal', submittedAt: core.iso() })
      withdrawals.patch(core.db, intentId, { refundIntentId: refundId }, core.iso())
      return true
    })()
    if (!created) return
    core.log.error(`[ramp/sell] ${intentId} not paid to MoonPay (${reason}); returning ${w.amountMinor} to the user as ${refundId}`)
    emitIntent(core, intentId)
    applyReceived(core, refundId)
  }

  // ---------- 4. MoonPay's status ----------
  function applyStatus(w: Withdrawal, status: unknown, failureReason?: unknown): void {
    if (typeof status !== 'string' || !status) return
    if (w.moonpayStatus !== status) withdrawals.patch(core.db, w.intentId, { moonpayStatus: status }, core.iso())
    if (status === 'completed' && withdrawals.move(core.db, w.intentId, ['delivered'], 'paid_out', core.iso())) {
      core.log.info(`[ramp/sell] ${w.intentId}: MoonPay paid it out to the card`)
      emitIntent(core, w.intentId)
    }
    if (status === 'failed') {
      if (withdrawals.move(core.db, w.intentId, ['delivered'], 'moonpay_failed', core.iso(), { reason: String(failureReason ?? 'no reason given') })) {
        core.log.error(`[ramp/sell] ${w.intentId}: MoonPay failed the sale after our payment ${w.payHash} (${failureReason ?? 'no reason given'}); its refund goes to the treasury, return ${w.amountMinor} to the user by hand`)
        emitIntent(core, w.intentId)
      } else if (w.status === 'paying') core.track(pay(w.intentId), 'withdraw pay')
    }
  }

  /** A signed sell_transaction_* webhook. */
  function onSellEvent(data: any): void {
    if (!data || typeof data !== 'object' || typeof data.id !== 'string') return
    const s = rampSessions.byExternalId(core.db, data.externalTransactionId)
    if (!s || s.direction !== 'sell') return // not one of ours
    record(data, s.externalId, 'webhook')
    const w = withdrawals.byMoonPayId(core.db, data.id)
    if (w && w.externalId === s.externalId) applyStatus(w, data.status, data.failureReason)
  }

  /** Background pass (the ramp's watcher): payments a restart or an outage left behind, then MoonPay's status of what we paid. */
  async function scan(): Promise<void> {
    for (const w of withdrawals.withStatus(core.db, ['awaiting_approval', 'paying', 'sent'])) {
      if (intents.byId(core, w.intentId)?.status === 'received') await pay(w.intentId)
    }
    for (const w of withdrawals.withStatus(core.db, ['delivered'])) {
      const res = await readSale(w.moonpayTxId)
      if (res?.status !== 200 || res.body?.id !== w.moonpayTxId || res.body?.externalTransactionId !== w.externalId) continue
      record(res.body, w.externalId, 'api')
      applyStatus(w, res.body.status, res.body.failureReason)
    }
  }

  // ---------- routes (not in the contracts' route table yet: contract request) ----------
  function userOf(c: Context): UserRow {
    if (!on()) throw Err.featureOff()
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
    const s = token ? lookupSession(core, token) : undefined
    if (!s) throw Err.unauthorized()
    if (!s.user || s.user.status !== 'active') throw Err.notSignedUp()
    return s.user
  }

  function mountRoutes(app: Hono): void {
    app.post('/v1/ramp/sell/deposit', async (c) => {
      const u = userOf(c)
      let raw: unknown
      try {
        raw = await c.req.json()
      } catch {
        throw Err.badRequest('The request body must be JSON.')
      }
      const p = DepositBody.safeParse(raw)
      if (!p.success) throw Err.badRequest(zodMessage(p.error))
      return c.json(await deposit(u, p.data), 200)
    })
    app.get('/v1/ramp/sell/:id', (c) => {
      const u = userOf(c)
      const w = withdrawals.byIntent(core.db, c.req.param('id'))
      if (!w || w.userId !== u.id) throw Err.notFound()
      return c.json(view(w), 200)
    })
  }

  return { session, refuseToSign, mountRoutes, onSellEvent, scan, received: (_core: Core, intentId: string) => pay(intentId) }
}
