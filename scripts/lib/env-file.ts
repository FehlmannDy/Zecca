// Minimal .env reader/writer that keeps comments, blank lines and the exact text of lines it does not change.
// Values are never printed: errors name the key only.

export type EnvLine = { kind: 'pair'; key: string; value: string; raw: string } | { kind: 'other'; raw: string }
export type EnvDoc = EnvLine[]

const PAIR = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/

function parseValue(rest: string): string {
  const s = rest.trim()
  const q = s[0]
  if (q === '"' || q === "'" || q === '`') {
    const end = s.indexOf(q, 1)
    if (end > 0) {
      const inner = s.slice(1, end)
      return q === '"' ? inner.replace(/\\n/g, '\n') : inner
    }
  }
  const hash = s.search(/\s#/)
  return (hash >= 0 ? s.slice(0, hash) : s).trim()
}

export function parseEnv(text: string): EnvDoc {
  return text.split('\n').map((raw): EnvLine => {
    const m = PAIR.exec(raw)
    return m ? { kind: 'pair', key: m[1], value: parseValue(m[2]), raw } : { kind: 'other', raw }
  })
}

/** Key -> value (the last occurrence wins, as in Node's --env-file). */
export function envValues(doc: EnvDoc): Record<string, string> {
  const out: Record<string, string> = {}
  for (const l of doc) if (l.kind === 'pair') out[l.key] = l.value
  return out
}

/** Bare when safe, else single quotes (literal), else double quotes; refuses what neither can hold. */
export function formatEnvValue(key: string, value: string): string {
  if (/^[A-Za-z0-9_\-.:/@+=,~%]*$/.test(value)) return value
  if (!/[\n\r]/.test(value)) {
    if (!value.includes("'")) return `'${value}'`
    if (!/["\\]/.test(value)) return `"${value}"`
  }
  throw new Error(`env file: the value of ${key} cannot be written safely (quotes or a newline)`)
}

const pairLine = (key: string, value: string): EnvLine => ({ kind: 'pair', key, value, raw: `${key}=${formatEnvValue(key, value)}` })

/**
 * Adds keys that are absent, fills keys that are present but empty (in place), and keeps every key that has a value.
 * New keys go at the end, before the final newline.
 */
export function mergeEnv(doc: EnvDoc, values: Record<string, string>): { doc: EnvDoc; added: string[]; filled: string[]; kept: string[] } {
  const out = doc.map((l) => ({ ...l }))
  const added: string[] = []
  const filled: string[] = []
  const kept: string[] = []
  const fresh: EnvLine[] = []
  for (const [key, value] of Object.entries(values)) {
    let idx = -1
    out.forEach((l, i) => {
      if (l.kind === 'pair' && l.key === key) idx = i
    })
    if (idx < 0) {
      fresh.push(pairLine(key, value))
      added.push(key)
    } else if ((out[idx] as Extract<EnvLine, { kind: 'pair' }>).value === '') {
      out[idx] = pairLine(key, value)
      filled.push(key)
    } else kept.push(key)
  }
  if (fresh.length) {
    const last = out[out.length - 1]
    const endsWithNewline = last && last.kind === 'other' && last.raw === ''
    if (endsWithNewline) out.splice(out.length - 1, 0, ...fresh)
    else out.push(...fresh, { kind: 'other', raw: '' })
  }
  return { doc: out, added, filled, kept }
}

export function serializeEnv(doc: EnvDoc): string {
  return doc.map((l) => l.raw).join('\n')
}
