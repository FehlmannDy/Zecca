'use client'
// What the approve button may promise (UI.md §5.4): "Approve with Face ID" only with FEATURE_PASSKEY on, a phone that
// has a built-in authenticator, and a passkey enrolled with Privy; otherwise "Approve".
// The enrolment is remembered per signed-in account (the session's address): after a sign-out, the next person in the
// same tab starts from "unknown" and is read from Privy again, never from the previous person's answer.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useApp } from '@/lib/app'
import { sessionStore, useSession } from '@/lib/session'
import { getPrivy } from '@/lib/wallet/privy'
import {
  approveLabel,
  biometricWord,
  createEnrolledCache,
  installPasskeyMfa,
  isPasskeyAvailable,
  passkeyFeatureOn,
  patchPrivyIframeReady,
  readPasskeyStatus,
  type BiometricWord,
} from '@/lib/passkey'

const enrolledCache = createEnrolledCache()

/** The Privy account signed in now (its address), or null. */
function signedInAccount(): string | null {
  const s = sessionStore().get()
  return s?.signer === 'privy' ? s.address : null
}

/** Called by the "Add Face ID" screen once Privy reports the passkey enrolled, for the account signed in. */
export function markPasskeyEnrolled(v = true, account = signedInAccount()) {
  if (account) enrolledCache.set(account, v)
}

/** Reads the enrolment from Privy for the account signed in (null when Privy cannot tell yet on this page). */
export function readEnrolled(appId: string, account = signedInAccount()): Promise<boolean | null> {
  if (!account) return Promise.resolve(null)
  return enrolledCache.refresh(
    account,
    async () => {
      const { adapter } = await getPrivy(appId)
      patchPrivyIframeReady(adapter)
      const mfa = installPasskeyMfa(adapter)
      return mfa ? (await readPasskeyStatus(mfa.client)).enrolled : null
    },
    signedInAccount,
  )
}

export type PasskeyApproval = { on: boolean; available: boolean; enrolled: boolean; word: BiometricWord; label: string }

export function usePasskeyApproval(): PasskeyApproval {
  const { config } = useApp()
  const session = useSession()
  const account = session?.signer === 'privy' ? session.address : null
  const on = passkeyFeatureOn(config)
  const appId = config?.privyAppId
  const [available, setAvailable] = useState(false)
  const [word, setWord] = useState<BiometricWord>('Face ID')
  const enrolled = useSyncExternalStore(enrolledCache.subscribe, () => enrolledCache.get(account) === true, () => false)

  useEffect(() => {
    if (!on) return
    let live = true
    setWord(biometricWord())
    isPasskeyAvailable().then((v) => live && setAvailable(v))
    return () => {
      live = false
    }
  }, [on])

  // Read again whenever the account changes, and when Privy (re)connects (after a reload the adapter only has a
  // client once the connector has reconnected).
  useEffect(() => {
    if (!on || !account || !appId) return
    let live = true
    let off = () => {}
    const read = () => {
      if (live && enrolledCache.get(account) === null) readEnrolled(appId, account).catch(() => null)
    }
    getPrivy(appId)
      .then(({ manager }) => {
        if (!live) return
        manager.on('connect', read)
        off = () => void manager.off('connect', read)
        read()
      })
      .catch(() => null)
    return () => {
      live = false
      off()
    }
  }, [on, account, appId])

  return { on, available, enrolled, word, label: approveLabel({ featureOn: on, available, enrolled, word }) }
}
