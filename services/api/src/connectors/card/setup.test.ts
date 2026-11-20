import { describe, expect, it } from 'vitest'
import { createFakeLithic } from './fake-lithic'
import { enrollCardWebhook, publicBaseFrom } from './setup'

describe('card webhook enrollment (port of card-issuer/scripts/lithic-setup.js)', () => {
  it('enrolls <PUBLIC_WEBHOOK_BASE>/v1/webhooks/lithic/asa, reads the ASA secret and never prints it', async () => {
    const lithic = createFakeLithic()
    const lines: string[] = []
    const r = await enrollCardWebhook({ lithic, publicBase: 'https://abc.trycloudflare.com/', log: (m) => lines.push(m) })
    expect(lithic.enrolled).toBe('https://abc.trycloudflare.com/v1/webhooks/lithic/asa')
    expect(r.url).toBe(lithic.enrolled)
    expect(lithic.calls).toEqual(['enrollAsa', 'authStreamSecret', 'asaEnrollment'])
    expect(lines.join('\n')).not.toContain(lithic.secret)
    expect(lines.join('\n')).toMatch(/few minutes/)
  })

  it('refuses a base that is not https', async () => {
    await expect(enrollCardWebhook({ lithic: createFakeLithic(), publicBase: 'http://localhost:8800' })).rejects.toThrow(/https/)
  })

  it('finds the base in --base, then PUBLIC_WEBHOOK_BASE, then the tunnel file', () => {
    const read = (p: string) => (p.endsWith('tunnel-8800.url') ? 'https://t.trycloudflare.com\n' : undefined)
    expect(publicBaseFrom(['--base', 'https://a.example'], { PUBLIC_WEBHOOK_BASE: 'https://b.example' }, read, '/z')).toBe('https://a.example')
    expect(publicBaseFrom([], { PUBLIC_WEBHOOK_BASE: 'https://b.example' }, read, '/z')).toBe('https://b.example')
    expect(publicBaseFrom([], {}, read, '/z')).toBe('https://t.trycloudflare.com')
    expect(publicBaseFrom(['--port', '9000'], {}, read, '/z')).toBeUndefined()
  })
})
