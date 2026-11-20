import { describe, expect, it } from 'vitest'
import * as fx from '@zecca/contracts/fixtures'
import type { Activity, Intent } from '@zecca/contracts'
import { applyIntent, explorerHref, findActivity, ledgerRows, mergeActivity, statusWord } from './ledger-view'

const explorer = { devnet: 'https://devnet.xrpl.org/transactions/', testnet: 'https://testnet.xrpl.org/transactions' }

describe('explorerHref', () => {
  it('joins the base and the hash with exactly one slash', () => {
    expect(explorerHref(explorer, 'devnet', 'AB')).toBe('https://devnet.xrpl.org/transactions/AB')
    expect(explorerHref(explorer, 'testnet', 'AB')).toBe('https://testnet.xrpl.org/transactions/AB')
  })
})

describe('ledgerRows: You', () => {
  it('shows the amount, the counterparty by name and the fee', () => {
    const rows = ledgerRows(fx.activity.sentCarla, 'you', { explorer })
    expect(rows).toEqual([
      { key: 'amount', label: 'Amount', kind: 'amount', minor: 1200, direction: 'out' },
      { key: 'party', label: 'To', kind: 'party', text: 'Carla Rossi', sub: '@carla' },
      { key: 'fee', label: 'Fee', kind: 'amount', minor: 0 },
    ])
  })

  it('says "From" for money received, and names Zecca for credits', () => {
    const rows = ledgerRows(fx.activity.welcome, 'you', { explorer })
    expect(rows[1]).toEqual({ key: 'party', label: 'From', kind: 'party', text: 'Zecca' })
  })

  it('never shows a hash', () => {
    expect(ledgerRows(fx.activity.sentCarla, 'you', { explorer }).some((r) => r.kind === 'hash')).toBe(false)
  })
})

describe('ledgerRows: Everyone else', () => {
  it('seals the amount, puts the pool in place of the person, and links both transactions', () => {
    const rows = ledgerRows(fx.activity.sentCarla, 'everyone', { explorer })
    expect(rows).toEqual([
      { key: 'amount', label: 'Amount', kind: 'sealed', preview: '03D4E5B1B1B1B1B1' },
      { key: 'party', label: 'To', kind: 'party', text: 'Zecca pool' },
      { key: 'fee', label: 'Fee', kind: 'text', text: 'Not visible' },
      { key: 'deposit', label: 'Into the pool', kind: 'hash', hash: fx.HASH.deposit, href: `https://devnet.xrpl.org/transactions/${fx.HASH.deposit}` },
      { key: 'payout', label: 'Out of the pool', kind: 'hash', hash: fx.HASH.payout, href: `https://devnet.xrpl.org/transactions/${fx.HASH.payout}` },
    ])
  })

  it('never carries the amount or the counterparty’s name', () => {
    const text = JSON.stringify(ledgerRows(fx.activity.sentCarla, 'everyone', { explorer }))
    expect(text).not.toContain('Carla')
    expect(text).not.toContain('1200')
  })

  it('waits for the payout while it is on its way', () => {
    const rows = ledgerRows(fx.activity.coffee, 'everyone', { explorer })
    expect(rows.find((r) => r.key === 'payout')).toEqual({ key: 'payout', label: 'Out of the pool', kind: 'waiting', text: 'On its way' })
  })

  it('says nothing was sent when a payment failed before reaching the ledger', () => {
    const failed: Activity = { ...fx.activity.coffee, status: 'failed', ledger: { network: 'devnet' } }
    const rows = ledgerRows(failed, 'everyone', { explorer })
    expect(rows.find((r) => r.key === 'deposit')).toEqual({ key: 'deposit', label: 'Into the pool', kind: 'waiting', text: 'Not sent' })
    expect(rows.find((r) => r.key === 'payout')).toEqual({ key: 'payout', label: 'Out of the pool', kind: 'waiting', text: 'Not sent' })
  })

  it('shows the sign-up transaction for the demo credit, from Zecca, with no pool rows', () => {
    const rows = ledgerRows(fx.activity.welcome, 'everyone', { explorer })
    expect(rows.find((r) => r.key === 'party')).toEqual({ key: 'party', label: 'From', kind: 'party', text: 'Zecca' })
    expect(rows.filter((r) => r.kind === 'hash')).toEqual([
      { key: 'deposit', label: 'Sign-up', kind: 'hash', hash: fx.HASH.onboarding, href: `https://devnet.xrpl.org/transactions/${fx.HASH.onboarding}` },
    ])
    expect(rows.some((r) => r.key === 'payout')).toBe(false)
  })

  it('uses the network of the activity for the links', () => {
    const rows = ledgerRows(fx.activity.topup, 'everyone', { explorer })
    const dep = rows.find((r) => r.key === 'deposit')
    expect(dep && dep.kind === 'hash' && dep.href).toBe(`https://testnet.xrpl.org/transactions/${fx.HASH.topup}`)
  })
})

describe('statusWord', () => {
  it('says what happened in words', () => {
    expect(statusWord(fx.activity.sentCarla)).toBe('Sent')
    expect(statusWord(fx.activity.shop)).toBe('Paid')
    expect(statusWord(fx.activity.coffee)).toBe('Sending')
    expect(statusWord(fx.activity.welcome)).toBe('Received')
    expect(statusWord({ ...fx.activity.welcome, status: 'pending' })).toBe('Arriving')
    expect(statusWord({ ...fx.activity.coffee, status: 'failed' })).toBe('Failed')
  })
})

describe('applyIntent', () => {
  const intent: Intent = {
    ...(fx.intents.p2pCreated as Intent),
    id: fx.activity.coffee.intentId,
    status: 'paid_out',
    depositTxHash: fx.HASH.coffeeDeposit,
    payoutTxHash: fx.HASH.coffeePayout,
  }
  it('takes the status and the hashes from the intent', () => {
    const a = applyIntent(fx.activity.coffee, intent)
    expect(a.status).toBe('done')
    expect(a.ledger.payoutTxHash).toBe(fx.HASH.coffeePayout)
    expect(a.ledger.ciphertextPreview).toBe(fx.activity.coffee.ledger.ciphertextPreview)
  })
  it('leaves other activities alone', () => {
    expect(applyIntent(fx.activity.sentCarla, intent)).toBe(fx.activity.sentCarla)
  })
})

describe('mergeActivity / findActivity', () => {
  const list = [fx.activity.sentCarla, fx.activity.welcome]
  it('puts a new activity first', () => {
    expect(mergeActivity(list, fx.activity.coffee).map((a) => a.id)).toEqual(['act_coffee_out', 'act_p2p_carla_out', 'act_welcome'])
  })
  it('replaces an activity it already has, in place', () => {
    const updated = { ...fx.activity.welcome, note: 'x' }
    const out = mergeActivity(list, updated)
    expect(out.map((a) => a.id)).toEqual(['act_p2p_carla_out', 'act_welcome'])
    expect(out[1].note).toBe('x')
  })
  it('finds by activity id or by intent id', () => {
    expect(findActivity(list, 'act_welcome')).toBe(fx.activity.welcome)
    expect(findActivity(list, 'int_p2p_carla')).toBe(fx.activity.sentCarla)
    expect(findActivity(list, 'nope')).toBeUndefined()
  })
})
