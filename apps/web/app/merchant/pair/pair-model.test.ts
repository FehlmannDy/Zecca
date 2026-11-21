import { describe, expect, it } from 'vitest'
import { formatCode, newTillAfter, tillSubtitle, type TillView } from './pair-model'

const t = (id: string, name = 'Till', pairedAt = '2026-11-21T09:00:00.000Z', lastSeenAt?: string): TillView => ({ id, name, pairedAt, ...(lastSeenAt ? { lastSeenAt } : {}) })

describe('pair a till: model', () => {
  it('shows the code in two groups of four', () => {
    expect(formatCode('ABCD2345')).toBe('ABCD 2345')
    expect(formatCode('ABC')).toBe('ABC')
  })

  it('finds the till that just paired', () => {
    expect(newTillAfter([t('a')], [t('b', 'Pixel 8'), t('a')])?.name).toBe('Pixel 8')
    expect(newTillAfter([t('a')], [t('a')])).toBeUndefined()
  })

  it('says when a till was paired and last used, in plain words', () => {
    const now = Date.parse('2026-11-21T09:30:00.000Z')
    expect(tillSubtitle(t('a', 'Pixel 8', '2026-11-21T09:29:40.000Z'), now)).toBe('Paired just now')
    expect(tillSubtitle(t('a', 'Pixel 8', '2026-11-21T09:00:00.000Z', '2026-11-21T09:25:00.000Z'), now)).toBe('Paired 30 min ago · Used 5 min ago')
    expect(tillSubtitle(t('a', 'Pixel 8', '2026-11-21T06:00:00.000Z'), now)).toBe('Paired 3 h ago')
  })

})
