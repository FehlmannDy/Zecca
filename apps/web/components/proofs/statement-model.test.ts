import { describe, expect, it } from 'vitest'
import { statement as fixture } from '@zecca/contracts/fixtures'
import { ZeccaApiError } from '../../lib/api'
import { ledgerCopy, missingAsNull } from './statement-model'

const attested = { ...fixture, attestation: 'zecca' as const, lines: fixture.lines.map((l) => ({ ...l, amountProof: undefined })) }

describe('statement ledger copy', () => {
  it('on the real ledger, invites a check of each line and says the links prove the payments', () => {
    const c = ledgerCopy(attested, false)
    expect(c.links).toBe(true)
    expect(c.headline).toBe('Anyone can check each line on the public ledger.')
    expect(c.amounts).toContain('The links show that each payment happened.')
  })

  it('on the mock ledger, drops the links and says the transactions are simulated', () => {
    const c = ledgerCopy(attested, true)
    expect(c.links).toBe(false)
    expect(c.headline).toBe('Test mode: these transactions are simulated, so they have no record on the public ledger.')
    expect(c.headline).not.toContain('Anyone can check')
    expect(c.amounts).not.toContain('The links show')
    expect(c.amounts).toContain('attested by Zecca')
  })
})

describe('statement load', () => {
  it('turns a 404 into "no statement" and keeps every other error', async () => {
    await expect(missingAsNull(Promise.reject(new ZeccaApiError(404, { code: 'not_found', message: 'This statement does not exist.' })))).resolves.toBeNull()
    const offline = new ZeccaApiError(0, { code: 'upstream_error', message: "Can't reach Zecca right now. Check your connection and try again." })
    await expect(missingAsNull(Promise.reject(offline))).rejects.toBe(offline)
    const down = new ZeccaApiError(500, { code: 'internal', message: 'Something went wrong on our side. Try again in a moment.' })
    await expect(missingAsNull(Promise.reject(down))).rejects.toBe(down)
    await expect(missingAsNull(Promise.resolve(fixture))).resolves.toBe(fixture)
  })
})
