import { describe, expect, it } from 'vitest'
import type { Activity } from '@zecca/contracts'
import { MAX_LINES, selectable, toggle, toggleAll } from './selection'

const a = (id: string, status: Activity['status'] = 'done'): Activity => ({
  id,
  intentId: `int_${id}`,
  direction: 'out',
  kind: 'p2p',
  amountMinor: 100,
  feeMinor: 0,
  status,
  at: '2026-11-21T09:00:00.000Z',
  ledger: { network: 'devnet' },
})

describe('statement selection', () => {
  it('only completed items can go on a statement', () => {
    expect(selectable([a('1'), a('2', 'pending'), a('3', 'failed'), a('4')]).map((x) => x.id)).toEqual(['1', '4'])
  })
  it('toggles one item', () => {
    expect([...toggle(new Set(), '1')]).toEqual(['1'])
    expect([...toggle(new Set(['1', '2']), '1')]).toEqual(['2'])
  })
  it('select all picks every selectable item; again clears', () => {
    const items = [a('1'), a('2', 'pending'), a('3')]
    const all = toggleAll(new Set(), items)
    expect([...all].sort()).toEqual(['1', '3'])
    expect(toggleAll(all, items).size).toBe(0)
  })
  it('never selects more than the API accepts', () => {
    const many = Array.from({ length: MAX_LINES + 5 }, (_, k) => a(String(k)))
    expect(toggleAll(new Set(), many).size).toBe(MAX_LINES)
    const full = toggleAll(new Set(), many)
    expect(toggle(full, String(MAX_LINES + 1)).size).toBe(MAX_LINES)
  })
})
