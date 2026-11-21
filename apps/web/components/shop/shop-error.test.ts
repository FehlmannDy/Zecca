import { describe, expect, it } from 'vitest'
import { ZeccaApiError } from '../../lib/api'
import { basketCountLabel, shopTrouble } from './shop-error'

describe('shop load errors', () => {
  it('only feature_off reads as closed; a missing order says so; anything else can be retried', () => {
    expect(shopTrouble(new ZeccaApiError(404, { code: 'feature_off', message: 'This feature is not available yet.' }))).toEqual({ kind: 'closed' })
    expect(shopTrouble(new ZeccaApiError(404, { code: 'not_found', message: "We couldn't find this order." }))).toEqual({ kind: 'missing' })
    expect(shopTrouble(new ZeccaApiError(0, { code: 'upstream_error', message: "Can't reach Zecca right now." }))).toEqual({ kind: 'retry' })
    expect(shopTrouble(new ZeccaApiError(500, { code: 'internal', message: 'Something went wrong on our side.' }))).toEqual({ kind: 'retry' })
    expect(shopTrouble(new TypeError('Failed to fetch'))).toEqual({ kind: 'retry' })
  })

  it('the basket badge label is pluralised', () => {
    expect(basketCountLabel(0)).toBe('0 items')
    expect(basketCountLabel(1)).toBe('1 item')
    expect(basketCountLabel(3)).toBe('3 items')
  })
})
