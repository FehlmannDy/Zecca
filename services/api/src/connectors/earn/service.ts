// Earn (SPEC §4.7): dollars on Devnet -> XRP on Testnet -> Flare smart account -> Firelight vault, and back.
// Signer on Testnet: a per-user custodial wallet in the key store (SPEC §4.7 fallback; DECISIONS). One user approval:
// the confidential deposit to the pool (intent earn_deposit). Everything after 'received' runs here, per user in order,
// because a smart account takes one user op per nonce and the nonce only moves when Flare executes (~160 s).
//
// Deposit: quoted -> funding (pool has the dollars; treasury funds the wallet; Core Vault payment) -> opening (payment
// validated, Flare executing) -> active (isTransactionIdUsed). A silent Flare failure times out: failed, dollars returned.
// Withdrawal: requesting -> requested (Firelight.redeem ran; claimable when the next period ends) -> claiming -> redeeming
// (FXRP -> XRP by an agent) -> credited (dollars through the pool, minus EARN_FEE_BPS of the earnings and EARN_SWAP_BPS).
import type { Hex } from 'viem'
import { formatUsd, type EarnPosition, type PreparedTx } from '@zecca/contracts'
import type { Core } from '../../core'
import { Err } from '../../errors'
import { claimEffect, getBalance } from '../../books'
import { checkOutgoing } from '../../limits'
import { storePrepared } from '../../prepared/store'
import { users, type UserRow } from '../../users'
import { intents, toIntent, ZECCA } from '../../intents/repo'
import { applyReceived, ciphertextPreviewOf, emitIntent, startTopup } from '../../intents/flow'
import { claimCalls, depositCalls, redeemCalls, requestCalls } from './calls'
import { memoFF, memosField, type Call } from './memo'
import { dropsToUsdMinor, earnFeeDrops, fundingDrops, mintPlan, quoteDeposit, quoteWithdrawal, sharesFor } from './math'
import type { XrpPriceFeed } from './price'
import { deposits, points, steps, withdrawals, OPEN_WITHDRAWAL, type DepositRow, type DepositStatus, type StepRow } from './repo'
import type { FlareSide, MintParams, PaymentSpec, TestnetSide, TxOutcome, VaultPosition } from './sides'

/** Smallest deposit, in drops: a position must stay above the 5 XRP redeem minimum to come back out. */
export const MIN_DEPOSIT_DROPS = 6_000_000
/** Smallest withdrawal (redeemAmount minimum 5 XRP, plus room for the redemption fees). */
export const MIN_WITHDRAW_DROPS = 5_500_000
/** FXRP left in the smart account on each deposit for rounding (step3.mjs). Paid by Zecca, not the user. */
const MARGIN_UBA = 10_000n
/** Net mint riding along with an action-only payment: a payment must mint something to reach the account (step5.mjs). */
const SMALL_NET_UBA = 100_000n
/** Network fee room left in the wallet after a payment. */
const FEE_MARGIN_DROPS = 1_000n
/** The treasury asks the faucet for more when it would fall below what a payment needs plus this. */
const TREASURY_FLOOR_DROPS = 20_000_000n

export const COPY = {
  tier: 'Verify your identity to use Earn.',
  failedDeposit: "This deposit didn't reach Earn. Your dollars are back in your balance.",
  refundFailed: "This deposit didn't reach Earn and couldn't be returned yet. Our team has been told and will sort it out.",
  nothing: "There's nothing in Earn to withdraw yet.",
  busy: 'A withdrawal is already on its way.',
  failedRequest: "The withdrawal request didn't go through. Your money is still in Earn.",
  unreachable: "Earn can't be reached right now. Try again in a moment.",
} as const

export type EarnDeps = {
  testnet: TestnetSide
  flare: FlareSide
  price: XrpPriceFeed
  pollMs: number
  /** Silent-failure timeout from the Core Vault payment's validation to Flare's execution. */
  openTimeoutMs: number
  /** How long to wait for the agent's XRP payout after a redeem executed. */
  payoutTimeoutMs: number
  /** Cache for live position reads. */
  cacheMs: number
  feeBps: number
  swapBps: number
}

type Extras = {
  mode: 'live' | 'mock'
  rate: { minorPerXrp: number; microUsdPerXrp: number; at: string; source: string }
  inFlight?: { status: 'funding' | 'opening'; xrpDrops: number; amountMinor: number; since: string; openedAt?: string }
  lastFailure?: string
  ledger?: { testnetAddress: string; smartAccount?: string; lastPaymentHash?: string }
  stale?: boolean
}
export type PositionOut = EarnPosition & Extras

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Engine results that prove a blob was not applied (or applied as a failure): safe to sign a new one. */
const NOT_APPLIED = /^(tem|tef|tel|tec)/

export function createEarn(core: Core, d: EarnDeps) {
  const { testnet, flare } = d
  const queues = new Map<string, Promise<unknown>>()
  const running = new Map<string, Promise<void>>()
  const cache = new Map<string, { at: number; pos: VaultPosition }>()

  function serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const tail = queues.get(userId) ?? Promise.resolve()
    const run = tail.then(fn, fn)
    const settled = run.catch(() => {})
    queues.set(userId, settled)
    settled.then(() => queues.get(userId) === settled && queues.delete(userId))
    return run
  }
  const once = (key: string, fn: () => Promise<void>): Promise<void> => {
    const r = running.get(key)
    if (r) return r
    const p = fn().finally(() => running.delete(key))
    running.set(key, p)
    return p
  }

  // ---------- Testnet payments, crash-safe ----------
  /**
   * Pays once: the signed tx is stored (hash first) from inside the account's queue before it is sent, and a retry looks
   * the stored hash up, then resends that same blob, instead of signing a second payment.
   */
  async function submitOnce(key: string, from: 'treasury' | { user: string }, spec: () => Promise<PaymentSpec>): Promise<StepRow> {
    const s = steps.get(core, key)
    if (s?.status === 'validated') return s
    let out: TxOutcome
    if (s) {
      const r = await testnet.txResult(s.hash)
      if (r?.validated) {
        steps.validated(core, key, r.engineResult)
        return steps.get(core, key)!
      }
      if (r && NOT_APPLIED.test(r.engineResult)) {
        steps.drop(core, key)
        throw new Error(`${key}: ${r.engineResult}`)
      }
      out = await testnet.submit(s.blob)
    } else {
      const p = await spec()
      out = await testnet.pay(from, p, (signed) => steps.insert(core, key, signed))
    }
    if (out.validated) {
      steps.validated(core, key, out.engineResult)
      return steps.get(core, key)!
    }
    if (NOT_APPLIED.test(out.engineResult)) steps.drop(core, key)
    throw new Error(`${key}: ${out.engineResult}`)
  }

  /**
   * One XRPL payment from the user's wallet to the Core Vault carrying one user op (ff.mjs sendFF): funds the wallet from the
   * treasury if short, builds the compact memo at the account's nonce, checks the size and the eth_call simulation, sends.
   */
  async function payFlare(key: string, o: { user: UserRow; wallet: string; pa: Hex; calls: () => Promise<Call[]>; netUBA: bigint; marginUBA: bigint; p: MintParams }): Promise<StepRow> {
    const plan = mintPlan({ depositUBA: o.netUBA, marginUBA: o.marginUBA, feeBips: o.p.feeBips, minFeeUBA: o.p.minFeeUBA, execFeeUBA: o.p.execFeeUBA })
    if (!steps.get(core, `${key}:pay`) && !steps.get(core, `${key}:fund`)) {
      const need = fundingDrops({ paymentDrops: plan.amountDrops, balanceDrops: await testnet.balanceDrops(o.wallet), reserveDrops: await testnet.reserveDrops(), feeMarginDrops: FEE_MARGIN_DROPS })
      if (need > 0n) {
        await testnet.topUpTreasury(need + TREASURY_FLOOR_DROPS)
        await submitOnce(`${key}:fund`, 'treasury', async () => ({ Destination: o.wallet, Amount: need.toString() }))
      }
    } else if (steps.get(core, `${key}:fund`)?.status === 'signed') {
      await submitOnce(`${key}:fund`, 'treasury', async () => {
        throw new Error('unreachable')
      })
    }
    return submitOnce(`${key}:pay`, { user: o.user.address }, async () => {
      const calls = await o.calls()
      const nonce = await flare.nonce(o.pa)
      const memo = memoFF({ sender: o.pa, nonce, calls, executorFeeUBA: o.p.execFeeUBA, compact: true })
      const Memos = memosField(memo)
      const sim = await flare.simulate(memoFF({ sender: o.pa, nonce, calls, executorFeeUBA: 0n, compact: true }), o.wallet)
      if (sim !== 'ok' && sim !== 'CallFailed') throw new Error(`${key}: the Flare simulation refused the memo (${sim})`)
      core.log.info(`[earn] ${key}: nonce ${nonce}, ${plan.amountDrops} drops, memo ${(memo.length - 2) / 2} B, simulation ${sim}`)
      return { Destination: o.p.coreVault, Amount: plan.amountDrops.toString(), Memos }
    })
  }

  /**
   * Polls MAC.isTransactionIdUsed until true or the silent-failure timeout (counted from the payment's validation).
   * 'not_executed' only when a read succeeded after the timeout and said no; 'unknown' when that last read failed, so a
   * Coston2 outage is never taken for a silent failure (the caller keeps the step and the resume tick asks again).
   */
  async function waitExecuted(hash: string, sinceIso: string | undefined): Promise<'executed' | 'not_executed' | 'unknown'> {
    const started = Date.now()
    const already = sinceIso ? Math.max(0, core.now() - Date.parse(sinceIso)) : 0
    const read = () =>
      flare.isExecuted(hash).catch((e) => {
        core.log.warn(`[earn] Coston2 read for ${hash}: ${(e as Error).message}`)
        return null
      })
    for (;;) {
      if ((await read()) === true) return 'executed'
      if (already + (Date.now() - started) >= d.openTimeoutMs) {
        const last = await read()
        return last === null ? 'unknown' : last ? 'executed' : 'not_executed'
      }
      await sleep(d.pollMs)
    }
  }

  async function readPosition(userId: string, wallet: string, fresh = false): Promise<VaultPosition> {
    const c = cache.get(userId)
    if (!fresh && c && Date.now() - c.at < d.cacheMs) return c.pos
    const pos = await flare.position(wallet)
    cache.set(userId, { at: Date.now(), pos })
    return pos
  }
  const recordPoint = (userId: string, valueDrops: number) => {
    const last = points.ofUser(core, userId).at(-1)
    const now = core.now()
    if (last && last.valueDrops === valueDrops && now - Date.parse(last.at) < 10 * 60_000) return
    if (last && now - Date.parse(last.at) < 60_000 && last.valueDrops === valueDrops) return
    points.add(core, userId, core.iso(now), valueDrops)
  }

  // ---------- deposit ----------
  async function minimumMinor(microUsdPerXrp: number): Promise<number> {
    let m = Math.ceil(Math.ceil((MIN_DEPOSIT_DROPS * microUsdPerXrp) / 1e10) / (1 - d.swapBps / 10_000) / 100) * 100
    while (quoteDeposit({ amountMinor: m, microUsdPerXrp, swapBps: d.swapBps }).xrpDrops < MIN_DEPOSIT_DROPS) m += 100
    return m
  }

  /** What the treasury must hold to fund a deposit into an empty wallet: payFlare's funding plus the treasury's floor. */
  const treasuryNeedDrops = (xrpDrops: number, p: MintParams, reserveDrops: bigint) =>
    fundingDrops({
      paymentDrops: mintPlan({ depositUBA: BigInt(xrpDrops), marginUBA: MARGIN_UBA, feeBips: p.feeBips, minFeeUBA: p.minFeeUBA, execFeeUBA: p.execFeeUBA }).amountDrops,
      balanceDrops: 0n,
      reserveDrops,
      feeMarginDrops: FEE_MARGIN_DROPS,
    }) + TREASURY_FLOOR_DROPS

  /** The largest whole-dollar amount up to `upperMinor` that `fits` (fits grows false with the amount). */
  function largestMinor(fits: (minor: number) => boolean, upperMinor: number): number {
    let lo = 0
    let hi = Math.floor(upperMinor / 100)
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (fits(mid * 100)) lo = mid
      else hi = mid - 1
    }
    return lo * 100
  }

  async function prepareDeposit(user: UserRow, amountMinor: number) {
    if (user.tier !== 1) throw Err.forbidden(COPY.tier)
    const rate = await d.price.rate()
    const q = quoteDeposit({ amountMinor, microUsdPerXrp: rate.microUsdPerXrp, swapBps: d.swapBps })
    if (q.xrpDrops < MIN_DEPOSIT_DROPS) throw Err.badRequest(`Add at least ${formatUsd(await minimumMinor(rate.microUsdPerXrp))} to Earn.`)
    checkOutgoing(core, user, undefined, amountMinor, 0)
    const b = getBalance(core, user.id)
    if (b.availableMinor < amountMinor) throw Err.insufficient(amountMinor - b.availableMinor)
    // Refuse now, not after the approval, what the Testnet treasury cannot fund even with every faucet grant.
    const [fundable, p, reserve] = await Promise.all([testnet.fundableDrops(), flare.mintParams(), testnet.reserveDrops()]).catch((e) => {
      core.log.warn(`[earn] treasury capacity read: ${(e as Error).message}`)
      throw Err.upstream(COPY.unreachable)
    })
    const fits = (minor: number) => treasuryNeedDrops(quoteDeposit({ amountMinor: minor, microUsdPerXrp: rate.microUsdPerXrp, swapBps: d.swapBps }).xrpDrops, p, reserve) <= fundable
    if (!fits(amountMinor)) throw Err.badRequest(`Add at most ${formatUsd(largestMinor(fits, amountMinor))} to Earn.`)
    core.rateLimit(user.address)

    const id = core.id('int')
    core.db.transaction(() => {
      intents.insert(core, { id, kind: 'earn_deposit', status: 'created', fromUserId: user.id, amountMinor, feeMinor: q.swapFeeMinor, note: 'To Earn' })
      deposits.insert(core, { intentId: id, userId: user.id, amountMinor, swapFeeMinor: q.swapFeeMinor, rateMicro: rate.microUsdPerXrp, rateAt: rate.at, rateSource: rate.source, xrpDrops: q.xrpDrops })
    })()
    let prepared: PreparedTx
    try {
      const tx = () =>
        core.ledger.buildSend({
          from: user.address,
          to: core.keystore.getWallet('pool').address,
          amountMinor,
          senderKey: core.keystore.getElGamal({ user: user.address }),
          sponsored: true,
          publicKey: user.publicKey,
        })
      prepared = await storePrepared(core, { address: user.address, publicKey: user.publicKey, kind: 'send', tx, intentId: id })
      intents.patch(core, id, { prepareId: prepared.prepareId, ciphertextPreview: ciphertextPreviewOf(prepared.tx) })
    } catch (e) {
      core.log.error(`[earn] prepare ${id} failed: ${(e as Error).message}`)
      intents.transition(core, id, 'created', 'failed', { failure: { code: 'prepare_failed', message: "We couldn't prepare this. Try again." } })
      deposits.move(core, id, ['quoted'], 'failed', { failure: 'prepare_failed' })
      throw Err.ledger()
    }
    return {
      intent: toIntent(intents.byId(core, id)!),
      prepared,
      quote: { xrpDrops: q.xrpDrops, rateMinorPerXrp: q.rateMinorPerXrp, swapFeeMinor: q.swapFeeMinor, microUsdPerXrp: rate.microUsdPerXrp, rateAt: rate.at, rateSource: rate.source },
    }
  }

  function runDeposit(intentId: string): Promise<void> {
    const row = deposits.get(core, intentId)
    if (!row || row.status === 'active' || row.status === 'failed') return Promise.resolve()
    return once(`dep:${intentId}`, () => serial(row.userId, () => depositSteps(intentId)))
  }

  async function depositSteps(id: string): Promise<void> {
    let row = deposits.get(core, id)
    const i = intents.byId(core, id)
    if (!row || !i || row.status === 'active' || row.status === 'failed') return
    if (i.status !== 'received') return // only once the pool has the dollars
    const user = users.byId(core, row.userId)!
    try {
      deposits.move(core, id, ['quoted'], 'funding')
      const wallet = testnet.walletFor(user.address)
      const pa = await flare.personalAccount(wallet)
      deposits.patch(core, id, { testnetAddress: wallet, personalAccount: pa })
      row = deposits.get(core, id)!
      if (row.status === 'funding') {
        const p = await flare.mintParams()
        const amountUBA = BigInt(row.xrpDrops)
        const pay = await payFlare(`dep:${id}`, { user, wallet, pa, p, netUBA: amountUBA, marginUBA: MARGIN_UBA, calls: async () => depositCalls({ fxrp: p.fxrp, vault: p.vault, amountUBA, personalAccount: pa }) })
        deposits.move(core, id, ['funding'], 'opening', { vaultHash: pay.hash, openedAt: pay.validatedAt ?? core.iso() })
        cache.delete(user.id)
        core.log.info(`[earn] ${id}: Core Vault payment ${pay.hash} validated; waiting for Flare`)
        emitIntent(core, id)
      }
      row = deposits.get(core, id)!
      const executed = await waitExecuted(row.vaultHash!, row.openedAt)
      if (executed === 'unknown') return core.log.warn(`[earn] ${id}: Coston2 unreadable for ${row.vaultHash}; kept opening, the resume job asks again`)
      if (executed === 'not_executed') {
        core.log.error(`[earn] ${id}: Flare did not execute ${row.vaultHash} within ${d.openTimeoutMs} ms (silent failure)`)
        return failDeposit(id, 'flare_timeout')
      }
      const pos = await readPosition(user.id, wallet, true).catch(() => null)
      deposits.move(core, id, ['opening'], 'active', { activeAt: core.iso() })
      if (pos) recordPoint(user.id, Number(pos.assets))
      if (intents.transition(core, id, 'received', 'paid_out')) emitIntent(core, id)
      core.log.info(`[earn] ${id}: active (${row.xrpDrops} drops in Firelight)`)
    } catch (e) {
      const now = deposits.get(core, id)!
      // A Core Vault payment that may have reached the ledger must not be refunded: it can still execute. Resume later.
      if (now.status === 'opening' || steps.get(core, `dep:${id}:pay`)) {
        core.log.error(`[earn] ${id}: ${(e as Error).message} (kept ${now.status}, retried by the resume job)`)
        return
      }
      core.log.error(`[earn] ${id}: ${(e as Error).message}`)
      return failDeposit(id, 'earn_failed')
    }
  }

  /** The deposit failed: the dollars go back from the pool to the user through a normal payout (a new intent). */
  async function failDeposit(id: string, code: string): Promise<void> {
    if (!deposits.move(core, id, ['quoted', 'funding', 'opening'], 'failed', { failure: COPY.failedDeposit })) return
    const i = intents.byId(core, id)!
    cache.delete(i.fromUserId)
    const refundId = core.id('int')
    const created = core.db.transaction(() => {
      if (!claimEffect(core, `${id}:earn_refund`)) return false
      // A credit from Zecca's pool like a top-up ('topup' has no received handler, so the generic payout and merge settle it).
      intents.insert(core, { id: refundId, kind: 'topup', status: 'submitted', fromUserId: ZECCA, toUserId: i.fromUserId, amountMinor: i.amountMinor, feeMinor: 0, note: 'Back from Earn', submittedAt: core.iso() })
      deposits.patch(core, id, { refunded: true })
      return true
    })()
    core.log.warn(`[earn] ${id} failed (${code}); returning ${i.amountMinor} to the user as ${refundId}`)
    if (created) applyReceived(core, refundId)
  }

  // ---------- withdrawal ----------
  async function requestWithdrawal(user: UserRow, amountDrops: number): Promise<{ status: 'requested'; claimableAt: string }> {
    if (user.tier !== 1) throw Err.forbidden(COPY.tier)
    const wallet = deposits.ofUser(core, user.id).find((r) => r.testnetAddress)?.testnetAddress
    if (!wallet) throw Err.badRequest(COPY.nothing)
    if (withdrawals.open(core, user.id)) throw Err.conflict(COPY.busy)
    const pos = await readPosition(user.id, wallet, true).catch(() => {
      throw Err.upstream("We couldn't read your Earn balance right now. Try again in a moment.")
    })
    if (pos.shares === 0n || pos.assets === 0n) throw Err.badRequest(COPY.nothing)
    const assets = Number(pos.assets)
    let drops = Math.min(amountDrops, assets)
    if (assets - drops < MIN_WITHDRAW_DROPS) drops = assets
    if (drops < MIN_WITHDRAW_DROPS) throw Err.badRequest('Withdrawals start at 5.5 XRP.')
    const shares = sharesFor({ drops, assets, shares: Number(pos.shares) })
    const costBasisDrops = Number((BigInt(depositedDrops(user.id)) * shares) / pos.shares)
    const claimableAt = core.iso(Number(await flare.nextPeriodEnd()) * 1000)
    const id = core.id('ewd')
    if (!withdrawals.insertIfNoneOpen(core, { id, userId: user.id, requestedDrops: drops, shares, costBasisDrops, claimableAt })) throw Err.conflict(COPY.busy)
    cache.delete(user.id)
    core.track(runWithdrawal(id), 'earn withdrawal')
    return { status: 'requested', claimableAt }
  }

  function runWithdrawal(id: string, o: { force?: boolean } = {}): Promise<void> {
    const w = withdrawals.get(core, id)
    if (!w || !OPEN_WITHDRAWAL.includes(w.status)) return Promise.resolve()
    return once(`wd:${id}`, () => serial(w.userId, () => withdrawalSteps(id, o)))
  }

  async function withdrawalSteps(id: string, o: { force?: boolean }): Promise<void> {
    let w = withdrawals.get(core, id)
    if (!w || !OPEN_WITHDRAWAL.includes(w.status)) return
    const user = users.byId(core, w.userId)!
    const wallet = testnet.walletFor(user.address)
    const pa = await flare.personalAccount(wallet)
    const p = await flare.mintParams()
    const small = { user, wallet, pa, p, netUBA: SMALL_NET_UBA, marginUBA: 0n }
    try {
      if (w.status === 'requesting') {
        const cur = await flare.currentPeriod()
        const shares = w.shares
        const pay = await payFlare(`wd:${id}:request`, { ...small, calls: async () => requestCalls({ vault: p.vault, shares, personalAccount: pa }) })
        const executed = await waitExecuted(pay.hash, pay.validatedAt)
        if (executed === 'unknown') return core.log.warn(`[earn] withdrawal ${id}: Coston2 unreadable for the request ${pay.hash}; kept requesting`)
        if (executed === 'not_executed') {
          withdrawals.move(core, id, ['requesting'], 'failed', { failure: COPY.failedRequest })
          return core.log.error(`[earn] withdrawal ${id}: request ${pay.hash} not executed (silent failure)`)
        }
        let period: bigint | undefined
        let owed = 0n
        for (const candidate of [cur + 1n, cur + 2n, cur]) {
          const x = await flare.withdrawal(candidate, pa)
          if (x.assets > 0n && !x.claimed) {
            period = candidate
            owed = x.assets
            break
          }
        }
        if (period === undefined) throw new Error('withdrawal request executed but no period holds it')
        withdrawals.move(core, id, ['requesting'], 'requested', { period, owedDrops: Number(owed) })
        cache.delete(user.id)
        const after = await readPosition(user.id, wallet, true).catch(() => null)
        if (after) recordPoint(user.id, Number(after.assets))
        core.log.info(`[earn] withdrawal ${id}: requested for period ${period}, ${owed} drops`)
        return
      }
      if (w.status === 'requested') {
        if (!o.force && core.now() < Date.parse(w.claimableAt) - 5 * 60_000) return
        if ((await flare.currentPeriod()) <= w.period!) return
        withdrawals.move(core, id, ['requested'], 'claiming')
        w = withdrawals.get(core, id)!
      }
      if (w.status === 'claiming') {
        const period = w.period!
        const pay = await payFlare(`wd:${id}:claim`, { ...small, calls: async () => claimCalls({ vault: p.vault, period }) })
        const executed = await waitExecuted(pay.hash, pay.validatedAt)
        if (executed === 'unknown') return core.log.warn(`[earn] withdrawal ${id}: Coston2 unreadable for the claim ${pay.hash}; kept claiming`)
        if (executed === 'not_executed' || !(await flare.withdrawal(period, pa)).claimed) {
          withdrawals.move(core, id, ['claiming'], 'failed', { failure: 'claim_not_executed' })
          return core.log.error(`[earn] withdrawal ${id}: claim ${pay.hash} not executed; the FXRP is still claimable (manual)`)
        }
        withdrawals.move(core, id, ['claiming'], 'redeeming')
        w = withdrawals.get(core, id)!
      }
      if (w.status === 'redeeming') await redeemAndCredit(id, small)
    } catch (e) {
      core.log.error(`[earn] withdrawal ${id} (${withdrawals.get(core, id)?.status}): ${(e as Error).message}`)
    }
  }

  async function redeemAndCredit(id: string, small: { user: UserRow; wallet: string; pa: Hex; p: MintParams; netUBA: bigint; marginUBA: bigint }) {
    const { user, wallet, pa, p } = small
    let redeemUBA = 0n
    const pay = await payFlare(`wd:${id}:redeem`, {
      ...small,
      calls: async () => {
        // The FXRP minted by this same payment lands before the user op runs (FLARE_REPORT 5b).
        redeemUBA = (await flare.position(wallet)).fxrp + SMALL_NET_UBA
        return redeemCalls({ assetManager: p.assetManager, amountUBA: redeemUBA, to: wallet })
      },
    })
    // The agent's payout reaches the wallet ~20 s after Flare executes; measure from right after our payment validated.
    const baseKey = `wd:${id}:redeem:base`
    let base = steps.get(core, baseKey)?.hash
    if (!base) {
      base = (await testnet.balanceDrops(wallet)).toString()
      steps.insert(core, baseKey, { hash: base, blob: '' })
    }
    if ((await waitExecuted(pay.hash, pay.validatedAt)) !== 'executed') throw new Error(`redeem ${pay.hash} not executed yet`)
    const started = Date.now()
    let received = 0n
    for (;;) {
      received = (await testnet.balanceDrops(wallet)) - BigInt(base)
      if (received > 0n || Date.now() - started > d.payoutTimeoutMs) break
      await sleep(d.pollMs)
    }
    if (received <= 0n) throw new Error('no XRP payout from the agent yet')
    const w = withdrawals.get(core, id)!
    const owed = BigInt(w.owedDrops ?? 0)
    // The user's share of the payout (the rest came from the small mints Zecca paid for), then Zecca's cut of the yield.
    const redeemedFor = redeemUBA > 0n ? redeemUBA : owed
    const mine = redeemedFor > owed ? Number((received * owed) / redeemedFor) : Number(received)
    const feeDrops = earnFeeDrops({ withdrawnDrops: Number(owed), costBasisDrops: w.costBasisDrops, feeBps: d.feeBps })
    const rate = await d.price.rate()
    const q = quoteWithdrawal({ drops: Math.max(0, mine - feeDrops), microUsdPerXrp: rate.microUsdPerXrp, swapBps: d.swapBps })
    let creditIntentId: string | undefined
    if (q.netMinor > 0 && claimEffect(core, `earn:${id}:credit`)) {
      creditIntentId = startTopup(core, user, q.netMinor, { note: 'From Earn', reference: `earn:${id}` }).id
    }
    withdrawals.move(core, id, ['redeeming'], 'credited', { redeemedDrops: mine, feeDrops, creditMinor: q.netMinor, ...(creditIntentId ? { creditIntentId } : {}) })
    cache.delete(user.id)
    core.log.info(`[earn] withdrawal ${id}: ${received} drops paid out (${pa}), ${mine} the user's, fee ${feeDrops}, credit ${q.netMinor} cents`)
  }

  // ---------- position ----------
  function effectiveStatus(r: DepositRow): DepositStatus | null {
    if (r.status === 'failed') return null
    if (r.status !== 'quoted') return r.status
    const i = intents.byId(core, r.intentId)
    return i && (i.status === 'submitted' || i.status === 'received') ? 'funding' : null
  }

  function depositedDrops(userId: string): number {
    const active = deposits.ofUser(core, userId).filter((r) => r.status === 'active').reduce((s, r) => s + r.xrpDrops, 0)
    const out = withdrawals.ofUser(core, userId).filter((w) => w.status !== 'failed').reduce((s, w) => s + w.costBasisDrops, 0)
    return Math.max(0, active - out)
  }

  async function position(user: UserRow): Promise<PositionOut> {
    const rows = deposits.ofUser(core, user.id)
    const live = rows.map((r) => ({ r, s: effectiveStatus(r) })).filter((x) => x.s !== null) as { r: DepositRow; s: DepositStatus }[]
    const open = withdrawals.open(core, user.id)
    const anyWithdrawal = withdrawals.ofUser(core, user.id).length > 0
    const wallet = rows.find((r) => r.testnetAddress)?.testnetAddress
    const rate = await d.price.rate()
    const history = () => points.ofUser(core, user.id)

    let valueDrops = 0
    let stale = false
    const hasActive = live.some((x) => x.s === 'active')
    if (wallet && (hasActive || open || anyWithdrawal)) {
      try {
        const pos = await readPosition(user.id, wallet)
        valueDrops = Number(pos.assets)
        if (hasActive && valueDrops > 0) recordPoint(user.id, valueDrops)
      } catch (e) {
        stale = true
        valueDrops = history().at(-1)?.valueDrops ?? 0
        core.log.warn(`[earn] position read for ${user.handle}: ${(e as Error).message}`)
      }
    }
    const flight = [...live].reverse().find((x) => x.s === 'funding' || x.s === 'opening')
    const status: EarnPosition['status'] = live.some((x) => x.s === 'opening') ? 'opening' : live.some((x) => x.s === 'funding') ? 'funding' : valueDrops > 0 || open ? 'active' : 'none'
    const latest = rows.filter((r) => effectiveStatus(r) !== null || r.status === 'failed').at(-1)
    const last = [...rows].reverse().find((r) => r.vaultHash)

    return {
      depositedDrops: depositedDrops(user.id),
      valueDrops,
      valueUsdMinor: valueDrops ? dropsToUsdMinor(valueDrops, rate.microUsdPerXrp) : 0,
      history: history(),
      ...(open ? { pendingWithdrawal: { amountDrops: Math.max(1, open.owedDrops ?? open.requestedDrops), claimableAt: open.claimableAt } } : {}),
      status,
      mode: testnet.mode,
      rate: { minorPerXrp: Math.max(1, Math.round(rate.microUsdPerXrp / 10_000)), microUsdPerXrp: rate.microUsdPerXrp, at: rate.at, source: rate.source },
      ...(flight
        ? { inFlight: { status: flight.s as 'funding' | 'opening', xrpDrops: flight.r.xrpDrops, amountMinor: flight.r.amountMinor, since: flight.r.createdAt, ...(flight.r.openedAt ? { openedAt: flight.r.openedAt } : {}) } }
        : {}),
      ...(latest?.status === 'failed' && latest.failure && latest.failure !== 'prepare_failed' ? { lastFailure: latest.failure } : {}),
      ...(wallet ? { ledger: { testnetAddress: wallet, ...(last?.personalAccount ? { smartAccount: last.personalAccount } : {}), ...(last?.vaultHash ? { lastPaymentHash: last.vaultHash } : {}) } } : {}),
      ...(stale ? { stale } : {}),
    }
  }

  // ---------- jobs ----------
  /** Resumes deposits in flight (after a restart) and moves withdrawals on once claimable. */
  async function tick(o: { force?: boolean } = {}): Promise<void> {
    const pending = core.db
      .prepare(
        `SELECT d.intent_id AS id FROM earn_deposits d JOIN intents i ON i.id = d.intent_id
         WHERE d.status IN ('quoted', 'funding', 'opening') AND i.status = 'received'`,
      )
      .all() as { id: string }[]
    const work: Promise<void>[] = pending.map((r) => runDeposit(r.id))
    for (const w of withdrawals.withStatus(core, OPEN_WITHDRAWAL)) work.push(runWithdrawal(w.id, o))
    await Promise.all(work)
  }

  let timer: NodeJS.Timeout | null = null
  return {
    mode: testnet.mode,
    deps: d,
    prepareDeposit,
    runDeposit,
    position,
    requestWithdrawal,
    runWithdrawal,
    tick,
    startJobs(everyMs = 60_000) {
      if (timer) return
      const t0 = setTimeout(() => void tick().catch((e) => core.log.warn(`[earn] resume: ${(e as Error).message}`)), 3_000)
      t0.unref?.()
      timer = setInterval(() => void tick().catch((e) => core.log.warn(`[earn] tick: ${(e as Error).message}`)), everyMs)
      timer.unref?.()
    },
    stopJobs() {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}

export type Earn = ReturnType<typeof createEarn>
