// Zecca Till request and response shapes. They live here, not in the shared route table: the till routes are their own
// auth kind (a till token, not a session) and the web's mock API does not serve them.
import { z } from 'zod'
import { Id, IsoTime } from '@zecca/contracts'

/** Pairing codes: no 0/O, 1/I/L, so a code read off a screen is typed right. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const CODE_LENGTH = 8
export const PAIRING_TTL_MS = 10 * 60_000

const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`)

/** "abcd - efgh" -> "ABCDEFGH" (case, spaces and dashes do not matter). */
export const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[\s-]+/g, '')
export const isCode = (s: string): boolean => CODE_RE.test(s)

export const TillPairingCode = z.object({
  pairingCode: z.string().regex(CODE_RE),
  /** zecca-till://pair?api=<encoded API origin>&code=<code>: what the merchant space shows as a QR code. */
  qrPayload: z.string().startsWith('zecca-till://pair?'),
  expiresAt: IsoTime,
})
export const TillPairRequest = z.object({
  code: z.string().min(1).max(40),
  /** The phone's model, shown in the merchant's list of tills. */
  name: z.string().trim().min(1).max(40).optional(),
})
export const TillPairResponse = z.object({ tillToken: z.string().min(40), merchantName: z.string(), tillId: Id })
export const TillView = z.object({ id: Id, name: z.string(), pairedAt: IsoTime, lastSeenAt: IsoTime.optional() })
export const TillList = z.object({ items: z.array(TillView) })

export type TillView = z.infer<typeof TillView>
