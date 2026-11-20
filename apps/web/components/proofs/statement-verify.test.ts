import { describe, expect, it } from 'vitest'
import * as rk from 'ripple-keypairs'
import type { Statement } from '@zecca/contracts'
import { statement as fixture } from '@zecca/contracts/fixtures'
// The API's signer: what the page checks must be exactly what the API signs.
import { canonicalJson as apiCanonical, signStatement, statementKeyFrom } from '../../../../services/api/src/connectors/proofs/statement'
import { canonicalJson, checkSignature, signerStatus, statementFile, statementTotals } from './statement-verify'

const seed = rk.generateSeed({ algorithm: 'ecdsa-secp256k1' })
const key = statementKeyFrom({ address: rk.deriveAddress(rk.deriveKeypair(seed).publicKey), seed, algorithm: 'ecdsa-secp256k1' })
const { signature: _s, ...unsigned } = fixture
const signed = (): Statement =>
  signStatement(
    {
      ...unsigned,
      holder: { ...unsigned.holder, displayName: 'Ana Ferri · Caffè "Bruno" ✓' },
      lines: [...unsigned.lines, { ...unsigned.lines[0], activityId: 'act_2', direction: 'in', counterparty: 'Bruno', amountMinor: 450, feeMinor: 2 }],
    },
    key,
  )

describe('statement check in the browser', () => {
  it('canonicalises exactly like the API', () => {
    const s = signed()
    expect(canonicalJson(s)).toBe(apiCanonical(s))
    expect(canonicalJson({ z: [1, { b: null, a: 'é' }], y: undefined })).toBe(apiCanonical({ z: [1, { b: null, a: 'é' }], y: undefined }))
  })

  it('accepts a statement the API signed and names the signer address', () => {
    expect(checkSignature(signed())).toEqual({ ok: true, signerAddress: key.address })
  })

  it('refuses any edit to the content, and a signature made with another key', () => {
    const s = signed()
    expect(checkSignature({ ...s, lines: s.lines.map((l, k) => (k === 0 ? { ...l, counterparty: 'Someone else' } : l)) })).toMatchObject({ ok: false })
    const other = rk.deriveKeypair(rk.generateSeed({ algorithm: 'ecdsa-secp256k1' }))
    const forged = { ...s, signature: { ...s.signature, value: rk.sign(s.signature.signedPayloadSha256.toUpperCase(), other.privateKey) } }
    expect(checkSignature(forged)).toMatchObject({ ok: false })
    expect(checkSignature({ ...s, signature: { ...s.signature, value: 'zz' } })).toMatchObject({ ok: false })
  })

  it('totals in and out, and fees', () => {
    expect(statementTotals(signed())).toEqual({ inMinor: 450, outMinor: 1200, feeMinor: 2, count: 2 })
  })

  it("names the signer Zecca only when it is the statement signer Zecca's config publishes", () => {
    const zecca = { addresses: { pool: 'rPool', statementSigner: key.address } }
    expect(signerStatus(key.address, zecca)).toBe('zecca')
    expect(signerStatus(key.address, { addresses: { pool: 'rPool', statementSigner: 'rSomeoneElse' } })).toBe('other')
    expect(signerStatus(key.address, { addresses: { pool: 'rPool' } })).toBe('unknown')
    expect(signerStatus(key.address, null)).toBe('unknown')
    expect(signerStatus(undefined, zecca)).toBe('unknown')
  })

  it('the JSON file is the statement as served: it still checks after a save', () => {
    const s = signed()
    const f = statementFile(s)
    expect(f.name).toBe(`zecca-statement-${s.id}.json`)
    expect(f.type).toBe('application/json')
    expect(checkSignature(JSON.parse(f.text) as Statement)).toEqual({ ok: true, signerAddress: key.address })
  })
})
