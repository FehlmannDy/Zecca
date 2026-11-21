// The card expiry field of the demo shop's "Pay by card". A phone's numeric keypad has no "/", so the field keeps the
// digits and puts the slash in after the month ("1228" -> "12/28"); a typed or autofilled slash is kept ("1/" -> "01/",
// "12/2028" stays readable and parses to 2028).

export function formatExpiry(value: string): string {
  const slash = value.indexOf('/')
  if (slash >= 0) {
    const month = value.slice(0, slash).replace(/\D/g, '').slice(-2)
    if (!month) return ''
    return `${month.padStart(2, '0')}/${value.slice(slash + 1).replace(/\D/g, '').slice(0, 4)}`
  }
  const d = value.replace(/\D/g, '').slice(0, 4)
  return d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d
}

/** "MM/YY" or "MM/YYYY" -> month and full year, or null. */
export function parseExpiry(value: string): { expMonth: number; expYear: number } | null {
  const m = /^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/.exec(value.trim())
  if (!m) return null
  const expMonth = Number(m[1])
  if (expMonth < 1 || expMonth > 12) return null
  return { expMonth, expYear: 2000 + Number(m[2].slice(-2)) }
}
