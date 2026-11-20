// Every text colour pair in both themes reaches WCAG AA (4.5:1); the brass accent reaches 3:1 for the focus ring.
// Reads the tokens straight from app/globals.css, so the file and the check cannot drift apart.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../app/globals.css', import.meta.url)), 'utf8')

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector)
  if (start < 0) throw new Error(`no ${selector} block`)
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start))
  return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]))
}

const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const themes = { light: block(':root {'), dark: block(":root[data-theme='dark'] {") }
const TEXT = ['ink', 'muted', 'in', 'out', 'alert', 'sealed']

describe('design tokens', () => {
  it('match UI.md §2', () => {
    expect(themes.light).toMatchObject({ paper: '#f5f2eb', surface: '#ffffff', ink: '#0c0c0d', muted: '#6b6a66', line: '#ddd8cc', brass: '#a8842f', in: '#1e6b57', alert: '#b23a24', sealed: '#23324f' })
    expect(themes.dark).toMatchObject({ paper: '#0c0d0f', surface: '#16181b', ink: '#f2efe8', muted: '#9a988f', line: '#2a2c30', brass: '#d2ae5a', in: '#58b79c', alert: '#e5745c', sealed: '#8fa6d6' })
  })

  for (const [name, t] of Object.entries(themes)) {
    it(`${name}: every text colour reaches 4.5:1 on paper and on surface`, () => {
      for (const fg of TEXT) for (const bg of ['paper', 'surface']) expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(t.paper, t.ink), 'paper on ink (primary button)').toBeGreaterThanOrEqual(4.5)
    })
    it(`${name}: the brass focus ring reaches 3:1 against the page`, () => {
      expect(contrast(t.brass, t.paper)).toBeGreaterThanOrEqual(3)
    })
  }
})
