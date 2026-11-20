// Sign-up recovery: the server may already hold the account while this browser lost track of it (the tab was
// reloaded or closed during the approval, or the reply dropped). GET /v1/me answers only for a finished sign-up.
import type { User } from '@zecca/contracts'
import type { ApiClient } from './api'

/** The account behind this session if sign-up already finished on the server; null if not (or Zecca is unreachable). */
export function signedUpUser(api: Pick<ApiClient, 'call'>): Promise<User | null> {
  return api.call('me').catch(() => null)
}
