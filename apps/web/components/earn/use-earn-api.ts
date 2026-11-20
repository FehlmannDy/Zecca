'use client'
import { useMemo } from 'react'
import { API_ORIGIN, whenMockReady } from '@/lib/app'
import { sessionStore } from '@/lib/session'
import { createEarnApi, type EarnApi } from './earn-api'

/** The Earn routes with the session, on the same origin and mock worker as the app's client. */
export function useEarnApi(): EarnApi {
  return useMemo(
    () =>
      createEarnApi({
        origin: API_ORIGIN,
        getToken: () => sessionStore().get()?.token,
        onUnauthorized: () => sessionStore().clear(),
        fetch: async (...a) => {
          await whenMockReady()
          return fetch(...a)
        },
      }),
    [],
  )
}
