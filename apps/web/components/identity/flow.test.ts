import { describe, expect, it } from 'vitest'
import * as fixtures from '@zecca/contracts/fixtures'
import { formatBirthDate, liftedLimitsLine, needsFreshApproval, nextPollMs, viewOf, walletLink, WALLETS } from './flow'

const LINK = 'eudi-openid4vp://?client_id=x509_san_dns%3Averifier-backend.eudiw.dev&request_uri=https%3A%2F%2Fv%2Fr%2Fabc&request_uri_method=get'

describe('identity screen logic', () => {
  it('walletLink: the EU wallet keeps eudi-openid4vp; other wallets (Paradym, Procivis) get openid4vp; the query is untouched', () => {
    expect(walletLink(LINK, 'eudi')).toBe(LINK)
    expect(walletLink(LINK, 'other')).toBe(LINK.replace(/^eudi-openid4vp:/, 'openid4vp:'))
    expect(walletLink(walletLink(LINK, 'other'), 'eudi')).toBe(LINK)
    expect(WALLETS.map((w) => w.id)).toEqual(['eudi', 'other'])
  })

  it('viewOf maps the API status to what the screen shows', () => {
    expect(viewOf({ status: 'pending' })).toEqual({ kind: 'waiting' })
    const prepared = fixtures.preparedSend
    const id = { givenName: 'Ana', familyName: 'Ferri', birthDate: '1994-03-12', over18: true }
    expect(viewOf({ status: 'verified', identity: id, prepared })).toEqual({ kind: 'approve', identity: id, prepared })
    expect(viewOf({ status: 'verified', identity: id })).toEqual({ kind: 'verified', identity: id, message: undefined })
    expect(viewOf({ status: 'verified', identity: { ...id, over18: false }, message: 'You need to be 18 or older to lift the limits.' })).toEqual({
      kind: 'verified',
      identity: { ...id, over18: false },
      message: 'You need to be 18 or older to lift the limits.',
    })
    expect(viewOf({ status: 'rejected', message: 'No.' })).toEqual({ kind: 'failed', message: 'No.' })
    expect(viewOf({ status: 'error' })).toEqual({ kind: 'failed', message: "That didn't work. Start again." })
  })

  it('polls every 2 s, and stops at the session expiry', () => {
    const exp = '2026-11-21T09:10:00.000Z'
    expect(nextPollMs(exp, Date.parse('2026-11-21T09:00:00Z'))).toBe(2000)
    expect(nextPollMs(exp, Date.parse('2026-11-21T09:09:59Z'))).toBe(2000)
    expect(nextPollMs(exp, Date.parse('2026-11-21T09:10:00Z'))).toBeNull()
  })

  it('asks for a fresh approval when the one in hand is about to expire', () => {
    const now = Date.parse('2026-11-21T09:00:00Z')
    expect(needsFreshApproval({ expiresAt: '2026-11-21T09:05:00Z' }, now)).toBe(false)
    expect(needsFreshApproval({ expiresAt: '2026-11-21T09:00:10Z' }, now)).toBe(true)
  })

  it('formats the birth date in words and the lifted cap from config', () => {
    expect(formatBirthDate('1994-03-12')).toBe('12 March 1994')
    expect(formatBirthDate('2008-02-29')).toBe('29 February 2008')
    expect(formatBirthDate('junk')).toBe('junk')
    expect(liftedLimitsLine(fixtures.config.limits)).toBe('You can now send up to $5,000.00 per payment.')
  })
})
