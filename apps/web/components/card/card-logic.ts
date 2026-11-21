// Pure pieces of the card screens: number and expiry formats, the card form's checks, the payments list, the tilt.
import type { CardAuthorization } from '@zecca/contracts'

export const SECRET_SHOW_MS = 30_000
export const MAX_TILT_DEG = 6

const digits = (s: string) => s.replace(/\D/g, '')

/** "4111111111114417" -> "4111 1111 1111 4417". */
export const formatPan = (pan: string) => digits(pan).replace(/(\d{4})(?=\d)/g, '$1 ')

/** The lengths a card number needs: 15 digits and a 4-digit code for American Express (34, 37), else 16 and 3. */
export function cardLengths(pan: string): { pan: number; cvc: number } {
  return /^3[47]/.test(digits(pan)) ? { pan: 15, cvc: 4 } : { pan: 16, cvc: 3 }
}

/** What a person types in the number field, cleaned, grouped and stopped at the card's length. */
export const formatCardNumberInput = (raw: string) => formatPan(digits(raw).slice(0, cardLengths(raw).pan))

/** What a person types in the security code field: digits only, stopped at the card's code length. */
export const formatCvcInput = (raw: string, pan: string) => digits(raw).slice(0, cardLengths(pan).cvc)

export const formatExpiry = (m: number, y: number) => `${String(m).padStart(2, '0')}/${String(y % 100).padStart(2, '0')}`

/** "11/29", "1129", "11 / 2029" -> { expMonth: 11, expYear: 2029 }. */
export function parseExpiry(s: string): { expMonth: number; expYear: number } | null {
  const m = /^\s*(\d{1,2})\s*\/?\s*(\d{2}|\d{4})\s*$/.exec(s)
  if (!m) return null
  const month = Number(m[1])
  if (month < 1 || month > 12) return null
  const y = Number(m[2])
  return { expMonth: month, expYear: m[2].length === 2 ? 2000 + y : y }
}

/**
 * Typing help for the expiry field (a phone's numeric keypad has no "/"): digits become "MM/YY" ("1228" -> "12/28",
 * "5" -> "05"), a typed or autofilled slash is kept ("1/" -> "01/", "12/2028" -> "12/28"), nothing past MM/YY.
 */
export function formatExpiryInput(raw: string): string {
  const slash = raw.indexOf('/')
  if (slash >= 0) {
    const month = digits(raw.slice(0, slash)).slice(-2)
    if (!month) return ''
    const year = digits(raw.slice(slash + 1))
    return `${month.padStart(2, '0')}/${year.length === 4 ? year.slice(2) : year.slice(0, 2)}`
  }
  let d = digits(raw)
  if (d && d[0] > '1') d = `0${d}` // no month starts with 2 to 9
  d = d.slice(0, 4)
  return d.length <= 2 ? d : `${d.slice(0, 2)}/${d.slice(2)}`
}

export type CardForm = { number: string; expiry: string; cvc: string }

export function cardFormErrors(f: CardForm, now = new Date()): Partial<Record<keyof CardForm, string>> {
  const e: Partial<Record<keyof CardForm, string>> = {}
  const n = digits(f.number)
  if (!n) e.number = 'Enter the card number.'
  else if (n.length < 12) e.number = 'This card number is too short.'
  else if (n.length > 19) e.number = 'This card number is too long.'
  const x = parseExpiry(f.expiry)
  if (!f.expiry.trim() || !x) e.expiry = 'Enter the expiry as MM/YY.'
  else if (x.expYear * 12 + x.expMonth < now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) e.expiry = 'This card has expired.'
  if (!/^\d{3,4}$/.test(f.cvc.trim())) e.cvc = 'Enter the 3 or 4 digit code.'
  return e
}

/** A new payment goes first; an update (authorised -> completed) replaces its row in place. */
export function upsertAuthorization(list: CardAuthorization[], a: CardAuthorization): CardAuthorization[] {
  const i = list.findIndex((x) => x.id === a.id)
  if (i < 0) return [a, ...list]
  const next = list.slice()
  next[i] = a
  return next
}

const STATUS: Record<CardAuthorization['status'], string> = {
  authorised: 'Authorised',
  completed: 'Completed',
  declined: 'Declined',
  voided: 'Cancelled',
  refunded: 'Refunded',
}
export const authStatusLabel = (s: CardAuthorization['status']) => STATUS[s]

/** The line under a payment: the decline in words, else the status. */
export const authLine = (a: CardAuthorization) => (a.status === 'declined' ? (a.declineReason ?? 'Declined, not enough on the card') : authStatusLabel(a.status))

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Pointer position inside the card (0..1 each way) -> rotation in degrees and the light's position in %. */
export function tiltFrom(px: number, py: number): { rx: number; ry: number; lx: number; ly: number } {
  const x = clamp(px, 0, 1)
  const y = clamp(py, 0, 1)
  const r = (v: number) => Math.round(v * 100) / 100 || 0
  return { rx: r((0.5 - y) * 2 * MAX_TILT_DEG), ry: r((x - 0.5) * 2 * MAX_TILT_DEG), lx: Math.round(x * 100), ly: Math.round(y * 100) }
}

/** Keeps only the latest request's answer: `begin()` returns a check that turns false after a newer begin or a cancel. */
export function latestOnly() {
  let n = 0
  return {
    begin(): () => boolean {
      const mine = ++n
      return () => mine === n
    },
    cancel(): void {
      n++
    },
  }
}
