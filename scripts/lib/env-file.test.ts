import { describe, expect, it } from 'vitest'
import { envValues, formatEnvValue, mergeEnv, parseEnv, serializeEnv } from './env-file'

const SAMPLE = [
  '# Zecca local environment',
  '',
  'LEDGER_MODE=mock',
  'export PRIVY_APP_ID=app-fake-123',
  'QUOTED="hello world"',
  "SINGLE='a#b c'",
  'INLINE=value # a comment',
  'EMPTY=',
  '  SPACED = padded  ',
  '# trailing comment',
  '',
].join('\n')

describe('env file', () => {
  it('parses pairs, export prefixes, quotes and inline comments', () => {
    const v = envValues(parseEnv(SAMPLE))
    expect(v).toEqual({
      LEDGER_MODE: 'mock',
      PRIVY_APP_ID: 'app-fake-123',
      QUOTED: 'hello world',
      SINGLE: 'a#b c',
      INLINE: 'value',
      EMPTY: '',
      SPACED: 'padded',
    })
  })

  it('serialises an untouched document byte for byte', () => {
    expect(serializeEnv(parseEnv(SAMPLE))).toBe(SAMPLE)
    expect(serializeEnv(parseEnv('A=1'))).toBe('A=1')
  })

  it('merge adds missing keys, fills empty ones in place and never changes a set one', () => {
    const r = mergeEnv(parseEnv(SAMPLE), { LEDGER_MODE: 'devnet', EMPTY: 'filled', NEW_KEY: 'fake-new', OTHER: 'x y' })
    expect(r.kept).toEqual(['LEDGER_MODE'])
    expect(r.filled).toEqual(['EMPTY'])
    expect(r.added).toEqual(['NEW_KEY', 'OTHER'])
    const text = serializeEnv(r.doc)
    const v = envValues(parseEnv(text))
    expect(v.LEDGER_MODE).toBe('mock')
    expect(v.EMPTY).toBe('filled')
    expect(v.NEW_KEY).toBe('fake-new')
    expect(v.OTHER).toBe('x y')
    // comments and order preserved; the empty key is filled where it was
    const lines = text.split('\n')
    expect(lines[0]).toBe('# Zecca local environment')
    expect(lines[7]).toBe('EMPTY=filled')
    expect(lines).toContain('# trailing comment')
    expect(lines.indexOf('NEW_KEY=fake-new')).toBeGreaterThan(lines.indexOf('# trailing comment'))
    expect(text.endsWith('\n')).toBe(true)
  })

  it('merge into an empty document', () => {
    const r = mergeEnv(parseEnv(''), { A: '1', B: '2' })
    expect(serializeEnv(r.doc)).toBe('A=1\nB=2\n')
  })

  it('quotes values only when needed and round-trips them', () => {
    expect(formatEnvValue('K', 'abc-DEF_1.2:3/4@5+6=7,8')).toBe('abc-DEF_1.2:3/4@5+6=7,8')
    expect(formatEnvValue('K', 'has space')).toBe("'has space'")
    expect(formatEnvValue('K', 'has#hash')).toBe("'has#hash'")
    expect(formatEnvValue('K', "it's")).toBe('"it\'s"')
    for (const value of ['has space', 'has#hash', "it's", 'https://sandbox.lithic.com/v1', 'x=y']) {
      expect(envValues(parseEnv(`K=${formatEnvValue('K', value)}`)).K).toBe(value)
    }
  })

  it('refuses a value it cannot write safely, without printing it', () => {
    const value = `a'b"c-fake-secret`
    let err: unknown
    try {
      formatEnvValue('PRIVY_APP_SECRET', value)
    } catch (e) {
      err = e
    }
    expect(String(err)).toMatch(/PRIVY_APP_SECRET/)
    expect(String(err)).not.toContain('fake-secret')
    expect(() => formatEnvValue('K', 'line1\nline2')).toThrow(/K/)
  })
})
