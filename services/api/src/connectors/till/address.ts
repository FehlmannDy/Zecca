// The client address a rate limit can key on. Railway's edge sets X-Real-IP to the client's remote IP and overwrites a
// caller's copy (Railway docs, Networking > Specs & Limits). X-Forwarded-For is never used: its first entries come from
// the caller, and the number of hops the edge adds is not fixed. Without X-Real-IP (a local run), the socket's address.
import type { Context } from 'hono'

export function clientAddress(c: Context): string {
  const edge = c.req.header('x-real-ip')?.trim()
  const socket = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket?.remoteAddress
  return edge || socket || 'local'
}
