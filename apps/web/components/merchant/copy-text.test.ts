import { describe, expect, it } from 'vitest'
import { copyText } from './copy-text'

describe('copyText', () => {
  it('uses the async clipboard when it works', async () => {
    const written: string[] = []
    const legacy = () => {
      throw new Error('not reached')
    }
    expect(await copyText('https://zecca.example/pay/pr_1', { clipboard: { writeText: async (t) => void written.push(t) }, legacyCopy: legacy })).toBe('copied')
    expect(written).toEqual(['https://zecca.example/pay/pr_1'])
  })

  it('falls back to the hidden-field copy when the clipboard refuses (http page, old browser)', async () => {
    const legacy: string[] = []
    const env = {
      clipboard: { writeText: () => Promise.reject(new Error('NotAllowedError')) },
      legacyCopy: (t: string) => (legacy.push(t), true),
    }
    expect(await copyText('abc', env)).toBe('copied')
    expect(legacy).toEqual(['abc'])
    expect(await copyText('abc', { clipboard: null, legacyCopy: () => true })).toBe('copied')
  })

  it("is 'manual' when nothing could copy, so the caller shows the text selected", async () => {
    expect(await copyText('abc', { clipboard: null, legacyCopy: () => false })).toBe('manual')
    expect(
      await copyText('abc', {
        clipboard: { writeText: () => Promise.reject(new Error('no')) },
        legacyCopy: () => {
          throw new Error('execCommand gone')
        },
      }),
    ).toBe('manual')
  })
})
