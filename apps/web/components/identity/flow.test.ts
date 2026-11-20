import { describe, expect, it } from 'vitest'
import * as fixtures from '@zecca/contracts/fixtures'
import { ZeccaApiError } from '../../lib/api'
import {
  approveIdentity,
  formatBirthDate,
  liftedLimitsLine,
  LIFT_WAIT_MS,
  needsFreshApproval,
  nextPollMs,
  NOT_THROUGH,
  STILL_CONFIRMING,
  viewOf,
  walletLink,
  WALLETS,
  type ApproveDeps,
} from './flow'

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

describe('approving the credential', () => {
  const identity = { givenName: 'Ana', familyName: 'Ferri', birthDate: '1994-03-12', over18: true }
  const user0 = { ...fixtures.users.ana, tier: 0 as const }
  const user1 = { ...fixtures.users.ana, tier: 1 as const }
  const held = { ...fixtures.preparedSend, kind: 'credential_accept' as const, prepareId: 'prep_held', expiresAt: '2026-11-21T09:07:00.000Z' }
  const fresh = { ...held, prepareId: 'prep_fresh' }
  const unconfirmed = () => new ZeccaApiError(502, { code: 'ledger_error', message: "The payment network hasn't confirmed this yet." })

  /** Scripted API: each call takes the next answer of its queue (the last one repeats). */
  function deps(o: { session?: unknown[]; submit?: unknown[]; me?: unknown[] }) {
    const calls: string[] = []
    let t = Date.parse('2026-11-21T09:00:00Z')
    const next = <T>(q: unknown[] | undefined, name: string): Promise<T> => {
      calls.push(name)
      const a = q && q.length > 1 ? q.shift() : q?.[0]
      return a instanceof Error ? Promise.reject(a) : Promise.resolve(a as T)
    }
    const d: ApproveDeps = {
      session: () => next(o.session, 'session'),
      submit: (p) => (calls.push(`submit:${p.prepareId}`), next(o.submit, 'answer')),
      me: () => next(o.me, 'me'),
      sleep: async (ms) => void (t += ms),
      now: () => t,
    }
    return { d, calls: () => calls.filter((c) => c !== 'answer') }
  }

  it('first press: signs the approval in hand and returns the lifted user', async () => {
    const { d, calls } = deps({ submit: [{ status: 'validated', user: user1 }] })
    expect(await approveIdentity(d, held, false)).toEqual(user1)
    expect(calls()).toEqual(['submit:prep_held'])
  })

  it('"already accepted" (tecDUPLICATE) answers failed with the lifted user: that is a success', async () => {
    const { d } = deps({ submit: [{ status: 'failed', engineResult: 'tecDUPLICATE', user: user1 }] })
    expect(await approveIdentity(d, held, false)).toEqual(user1)
  })

  it('a failed submit is one sentence; the retry asks the session first and signs the fresh approval, never the used one', async () => {
    const first = deps({ submit: [{ status: 'failed', engineResult: 'tefPAST_SEQ' }] })
    await expect(approveIdentity(first.d, held, false)).rejects.toThrow(NOT_THROUGH)
    const retry = deps({ session: [{ status: 'verified', identity, prepared: fresh }], submit: [{ status: 'validated', user: user1 }] })
    expect(await approveIdentity(retry.d, held, true)).toEqual(user1)
    expect(retry.calls()).toEqual(['session', 'submit:prep_fresh'])
  })

  it('unconfirmed: waits for the tier while the session says it is being confirmed', async () => {
    const confirming = { status: 'verified', identity, message: 'Your approval is being confirmed.' }
    const { d, calls } = deps({ submit: [unconfirmed()], me: [user0, user0, user1], session: [confirming] })
    expect(await approveIdentity(d, held, false)).toEqual(user1)
    expect(calls()).toEqual(['submit:prep_held', 'me', 'session', 'me', 'session', 'me'])
  })

  it('a retry while the first is being confirmed signs nothing and waits for the tier', async () => {
    const confirming = { status: 'verified', identity, message: 'Your approval is being confirmed.' }
    const { d, calls } = deps({ session: [confirming], me: [user0, user1] })
    expect(await approveIdentity(d, held, true)).toEqual(user1)
    expect(calls().filter((c) => c.startsWith('submit'))).toEqual([])
  })

  it('unconfirmed, then finally failed (a fresh approval appears): asks to try again; it gives up waiting after a while', async () => {
    const failed = deps({ submit: [unconfirmed()], me: [user0], session: [{ status: 'verified', identity, prepared: fresh }] })
    await expect(approveIdentity(failed.d, held, false)).rejects.toThrow(NOT_THROUGH)
    const slow = deps({ submit: [unconfirmed()], me: [user0], session: [{ status: 'verified', identity, message: 'Confirming.' }] })
    await expect(approveIdentity(slow.d, held, false)).rejects.toThrow(STILL_CONFIRMING)
    expect(slow.calls().filter((c) => c === 'me').length).toBe(LIFT_WAIT_MS / 2_000 + 1)
  })

  it('an approval about to expire is fetched again before signing; other errors pass through', async () => {
    const late = deps({ session: [{ status: 'verified', identity, prepared: fresh }], submit: [{ status: 'validated', user: user1 }] })
    const t = late.d.now()
    expect(await approveIdentity(late.d, { ...held, expiresAt: new Date(t + 10_000).toISOString() }, false)).toEqual(user1)
    expect(late.calls()).toEqual(['session', 'submit:prep_fresh'])
    const refused = deps({ submit: [new ZeccaApiError(403, { code: 'policy_refused', message: 'This approval was already used.' })] })
    await expect(approveIdentity(refused.d, held, false)).rejects.toThrow('This approval was already used.')
  })
})
