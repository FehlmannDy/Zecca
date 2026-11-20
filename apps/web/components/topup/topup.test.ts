import { describe, expect, it } from 'vitest'
import { DEFAULTS, type Activity, type Intent, type Limits, type ZeccaEvent } from '@zecca/contracts'
import { TOPUP_CHIPS, chipsFor, initialTopup, sdkEnvironment, topupReducer, type TopupState } from './topup'

const limits: Limits = {
  txCapMinor: DEFAULTS.TX_CAP_MINOR,
  dailyCapMinor: DEFAULTS.DAILY_CAP_MINOR,
  tier0: { balanceCapMinor: 15000, txCapMinor: 5000, monthlySendCapMinor: 15000 },
}
const at = '2026-11-21T09:00:00.000Z'
const intent = (o: Partial<Intent>): Intent => ({ id: 'int_1', kind: 'p2p', status: 'created', fromUserId: 'zecca', toUserId: 'usr_ana', amountMinor: 2852, feeMinor: 0, createdAt: at, updatedAt: at, ...o })
const activity = (o: Partial<Activity>): Activity => ({
  id: 'act_9',
  intentId: 'int_1',
  direction: 'in',
  kind: 'topup',
  amountMinor: 2852,
  feeMinor: 0,
  status: 'done',
  at,
  ledger: { network: 'testnet' },
  ...o,
})
const ev = {
  intent: (o: Partial<Intent>): ZeccaEvent => ({ type: 'intent.updated', data: intent(o), at }),
  activity: (o: Partial<Activity>): ZeccaEvent => ({ type: 'activity.created', data: activity(o), at }),
}
const run = (s: TopupState, ...events: ZeccaEvent[]) => events.reduce((x, e) => topupReducer(x, { type: 'event', event: e }), s)

describe('amount chips', () => {
  it('are $25, $50 and $100 (MoonPay asks for about €21.60 at least)', () => {
    expect(TOPUP_CHIPS).toEqual([2500, 5000, 10000])
  })
  it('tier 0: a chip that would take the balance (available + arriving) over the cap is off, with the room left', () => {
    expect(chipsFor({ tier: 0, availableMinor: 5000, pendingMinor: 0, limits })).toEqual({
      roomMinor: 10000,
      chips: [
        { minor: 2500, allowed: true },
        { minor: 5000, allowed: true },
        { minor: 10000, allowed: true },
      ],
    })
    expect(chipsFor({ tier: 0, availableMinor: 9000, pendingMinor: 1000, limits }).chips.map((c) => c.allowed)).toEqual([true, true, false])
    expect(chipsFor({ tier: 0, availableMinor: 14000, pendingMinor: 0, limits }).chips.every((c) => !c.allowed)).toBe(true)
  })
  it('tier 1 or an unknown balance: every chip is on', () => {
    expect(chipsFor({ tier: 1, availableMinor: 900000, pendingMinor: 0, limits })).toEqual({ roomMinor: null, chips: TOPUP_CHIPS.map((minor) => ({ minor, allowed: true })) })
    expect(chipsFor({ tier: 0, availableMinor: null, pendingMinor: null, limits }).chips.every((c) => c.allowed)).toBe(true)
  })
})

describe('sdkEnvironment', () => {
  it('follows the host the API signed for', () => {
    expect(sdkEnvironment('https://buy-sandbox.moonpay.com/?apiKey=pk&signature=x')).toBe('sandbox')
    expect(sdkEnvironment('https://buy.moonpay.com/?apiKey=pk')).toBe('production')
  })
})

describe('after the purchase: live events', () => {
  const waiting = topupReducer(initialTopup, { type: 'purchased', amountMinor: 5000 })

  it('waits for the transfer, then says what was added (the credit is the delivered amount, not the chip)', () => {
    expect(waiting).toMatchObject({ phase: 'waiting', expectedMinor: 5000 })
    expect(run(waiting, ev.intent({ status: 'submitted' }))).toMatchObject({ phase: 'arriving', intentId: 'int_1', amountMinor: 2852 })
    expect(run(waiting, ev.intent({ status: 'submitted' }), ev.activity({}))).toMatchObject({ phase: 'done', amountMinor: 2852 })
    expect(run(waiting, ev.activity({}))).toMatchObject({ phase: 'done', intentId: 'int_1' })
  })

  it('a refused or failed top-up shows the reason from the intent', () => {
    const s = run(waiting, ev.intent({ status: 'failed', failure: { code: 'limit_reached', message: 'We received your payment but could not add it.' } }), ev.activity({ status: 'failed' }))
    expect(s).toMatchObject({ phase: 'failed', message: 'We received your payment but could not add it.' })
    expect(run(waiting, ev.activity({ status: 'failed' }))).toMatchObject({ phase: 'failed', message: "We couldn't add this top-up. Our team has been told." })
  })

  it('ignores what is not a credit to this person: payments from people, sends, other intents once one is tracked, before a purchase', () => {
    expect(run(waiting, ev.intent({ fromUserId: 'usr_bob' }), ev.activity({ kind: 'p2p' }), ev.activity({ direction: 'out' }))).toEqual(waiting)
    const tracking = run(waiting, ev.intent({ id: 'int_1', status: 'submitted' }))
    expect(run(tracking, ev.intent({ id: 'int_2', status: 'failed' }), ev.activity({ intentId: 'int_2', status: 'failed' }))).toEqual(tracking)
    expect(run(initialTopup, ev.activity({}))).toEqual(initialTopup)
  })

  it('a demo credit is tracked by its intent id from POST /v1/dev/credit', () => {
    const s = topupReducer(initialTopup, { type: 'demoCredit', intent: intent({ id: 'int_demo', amountMinor: 5000 }) })
    expect(s).toMatchObject({ phase: 'arriving', intentId: 'int_demo', amountMinor: 5000, demo: true })
    expect(run(s, ev.activity({ intentId: 'int_x', kind: 'topup' }))).toEqual(s)
    expect(run(s, ev.activity({ intentId: 'int_demo', amountMinor: 5000 }))).toMatchObject({ phase: 'done', amountMinor: 5000 })
  })

  it("a later MoonPay callback (onTransactionCompleted after onTransactionCreated) never sends a finished screen back to waiting", () => {
    const done = run(waiting, ev.intent({ status: 'paid_out' }))
    expect(done.phase).toBe('done')
    expect(topupReducer(done, { type: 'purchased', amountMinor: 5000 })).toEqual(done)
    const arriving = run(waiting, ev.intent({ status: 'submitted' }))
    expect(topupReducer(arriving, { type: 'purchased', amountMinor: 5000 })).toEqual(arriving)
    expect(topupReducer(waiting, { type: 'purchased', amountMinor: 5000 })).toEqual(waiting)
  })

  it('without the live stream, the activity the screen polls moves it on (new rows only, the newest top-up, then the tracked one)', () => {
    const poll = (s: TopupState, items: Activity[]) => topupReducer(s, { type: 'activity', items })
    const later = '2026-11-21T09:01:00.000Z'
    const arriving = poll(waiting, [activity({ kind: 'p2p', intentId: 'int_p' }), activity({ intentId: 'int_old', status: 'pending' }), activity({ intentId: 'int_1', status: 'pending', at: later })])
    expect(arriving).toMatchObject({ phase: 'arriving', intentId: 'int_1', amountMinor: 2852 })
    expect(poll(arriving, [activity({ intentId: 'int_2', status: 'done', at: later })])).toEqual(arriving)
    expect(poll(arriving, [activity({ intentId: 'int_1', status: 'done', at: later })])).toMatchObject({ phase: 'done', intentId: 'int_1' })
    expect(poll(waiting, [activity({ direction: 'out' }), activity({ kind: 'p2p' })])).toEqual(waiting)
    expect(poll(initialTopup, [activity({})])).toEqual(initialTopup)
  })

  it('reset goes back to choosing an amount', () => {
    expect(topupReducer(run(waiting, ev.activity({})), { type: 'reset' })).toEqual(initialTopup)
  })
})
