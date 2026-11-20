// Port of card-issuer/test/lithic.test.js (node --test -> vitest).
import { describe, expect, it } from 'vitest'
import { buildResponse, parseAuthorization, sampleAuthorization, signHeaders, verifySignature } from './lithic-sig'

// Official example from https://docs.lithic.com/docs/events-api ("Example signature computation"), accessed 2026-11-20.
const V = {
  id: '65a9dad4-1b60-4686-83fd-65b25078a4b4',
  ts: 1698031907,
  secret: 'whsec_aDeFC3Zn55XB3PDD2zF0JP9cyrDHdV/18VOmkTcuyto=',
  body: '{"acquirer_fee":0,"amount":2000,"authorization_amount":2000}',
  sig: 'OGBiqPtc/O2sWacUsuS4pvTdfFBv6dqxYX/4UFzrbGk=',
}
const vHeaders = (sig = `v1,${V.sig}`, ts = V.ts) => ({ 'webhook-id': V.id, 'webhook-timestamp': String(ts), 'webhook-signature': sig })

describe('Lithic ASA signature', () => {
  it('reproduces the documented signature test vector', () => {
    expect(signHeaders(V.body, V.secret, { id: V.id, ts: V.ts })['webhook-signature']).toBe(`v1,${V.sig}`)
    expect(verifySignature(V.body, vHeaders(), V.secret, V.ts)).toBe(true)
  })

  it('accepts when any of several space-separated signatures matches (secret rotation)', () => {
    expect(verifySignature(V.body, vHeaders(`v1,AAAA v1,${V.sig}`), V.secret, V.ts)).toBe(true)
  })

  it('rejects a tampered body, a wrong secret, missing headers and a non-v1 version', () => {
    expect(verifySignature(V.body.replace('2000', '1'), vHeaders(), V.secret, V.ts)).toBe(false)
    expect(verifySignature(V.body, vHeaders(), 'whsec_' + Buffer.from('other').toString('base64'), V.ts)).toBe(false)
    expect(verifySignature(V.body, {}, V.secret, V.ts)).toBe(false)
    expect(verifySignature(V.body, vHeaders(`v2,${V.sig}`), V.secret, V.ts)).toBe(false)
  })

  it('rejects timestamps outside the 5 minute tolerance (replay)', () => {
    expect(verifySignature(V.body, vHeaders(), V.secret, V.ts + 301)).toBe(false)
    expect(verifySignature(V.body, vHeaders(), V.secret, V.ts - 301)).toBe(false)
    expect(verifySignature(V.body, vHeaders(), V.secret, V.ts + 299)).toBe(true)
    expect(verifySignature(V.body, vHeaders(`v1,${V.sig}`, Number.NaN), V.secret, V.ts)).toBe(false)
  })

  it('rejects an empty secret', () => {
    expect(verifySignature(V.body, vHeaders(), '', V.ts)).toBe(false)
  })

  it('works on raw bytes as well as strings', () => {
    expect(verifySignature(Buffer.from(V.body), vHeaders(), V.secret, V.ts)).toBe(true)
  })
})

describe('Lithic ASA request and response', () => {
  it('parses the documented fields and builds the documented response', () => {
    const auth = parseAuthorization(sampleAuthorization({ token: 't1', cardToken: 'c1', amount: 1234 }))
    expect(auth).toEqual({ id: 't1', cardToken: 'c1', amount: 1234, debitsFunds: true, status: 'AUTHORIZATION', merchant: 'HACKATHON COFFEE' })
    expect(buildResponse(auth, { approved: true })).toEqual({ token: 't1', result: 'APPROVED' })
    expect(buildResponse(auth, { approved: false })).toEqual({ token: 't1', result: 'INSUFFICIENT_FUNDS' })
    const credit = parseAuthorization(sampleAuthorization({ token: 't2', cardToken: 'c1', amount: 5, status: 'CREDIT_AUTHORIZATION' }))
    expect(credit.debitsFunds).toBe(false)
  })

  it('reads amounts.cardholder.amount, not the deprecated amount', () => {
    const body = { ...sampleAuthorization({ token: 't3', cardToken: 'c1', amount: 700 }), amount: 1 }
    expect(parseAuthorization(body).amount).toBe(700)
  })
})
