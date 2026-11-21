// Zecca Till: the pairing code rules. The request and response shapes are in the contracts' route table (Till*).
import { TILL_CODE_ALPHABET, TILL_CODE_LENGTH } from '@zecca/contracts'

export { TillList, TillPairRequest, TillPairResponse, TillPairingCode, TillView } from '@zecca/contracts'

export const CODE_ALPHABET = TILL_CODE_ALPHABET
export const CODE_LENGTH = TILL_CODE_LENGTH
export const PAIRING_TTL_MS = 10 * 60_000

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)

/** "abcd - efgh" -> "ABCDEFGH" (case, spaces and dashes do not matter). */
export const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[\s-]+/g, '')
export const isCode = (s: string): boolean => CODE_RE.test(s)
