// Text editing for amount entry. The value stays a string until parseUsdInput turns it into integer cents.
const MAX_DOLLAR_DIGITS = 7

export function keypadPress(current: string, key: string): string {
  if (key === 'back') return current.slice(0, -1)
  if (key === '.') {
    if (current.includes('.')) return current
    return (current || '0') + '.'
  }
  if (!/^\d$/.test(key)) return current
  const [whole, frac] = current.split('.')
  if (frac !== undefined) return frac.length >= 2 ? current : current + key
  if (whole === '0') return key
  if (whole.length >= MAX_DOLLAR_DIGITS) return current
  return current + key
}

/** Clean free typing or a paste: digits and one decimal point (a comma counts as one), two decimals at most. */
export function sanitizeAmountInput(raw: string): string {
  let s = raw.replace(/[$\s]/g, '')
  // "1,200.50" -> thousands separator; "12,5" -> decimal comma
  s = s.includes('.') ? s.replace(/,/g, '') : s.replace(/,(\d{0,2})$/, '.$1').replace(/,/g, '')
  s = s.replace(/[^\d.]/g, '')
  return [...s].reduce((acc, ch) => keypadPress(acc, ch), '')
}
