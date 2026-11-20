import { z } from 'zod'
import { Activity, Balance, CardAuthorization, Intent, PaymentRequest } from './domain'
import { IsoTime } from './primitives'

/** Server-Sent Events. Each SSE message's `data:` line is one JSON-encoded ZeccaEvent; the SSE `event:` field equals `type`. */
export const ZeccaEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('balance.updated'), data: Balance, at: IsoTime }),
  z.object({ type: z.literal('intent.updated'), data: Intent, at: IsoTime }),
  z.object({ type: z.literal('payment_request.updated'), data: PaymentRequest, at: IsoTime }),
  z.object({ type: z.literal('activity.created'), data: Activity, at: IsoTime }),
  z.object({ type: z.literal('card.authorization'), data: CardAuthorization, at: IsoTime }),
  /** Keep-alive; clients ignore it. */
  z.object({ type: z.literal('ping'), data: z.object({}), at: IsoTime }),
])
export type ZeccaEvent = z.infer<typeof ZeccaEvent>
export type ZeccaEventType = ZeccaEvent['type']
export const EVENT_TYPES = ['balance.updated', 'intent.updated', 'payment_request.updated', 'activity.created', 'card.authorization', 'ping'] as const
