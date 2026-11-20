'use client'
// What the approve button may promise (UI.md §5.4): "Approve with Face ID" only with FEATURE_PASSKEY on, a phone that
// has a built-in authenticator, and a passkey enrolled with Privy; otherwise "Approve".
import { useEffect, useState } from 'react'
import { useApp } from '@/lib/app'
import { getPrivy } from '@/lib/wallet/privy'
import { approveLabel, biometricWord, installPasskeyMfa, isPasskeyAvailable, passkeyFeatureOn, patchPrivyIframeReady, readPasskeyStatus, type BiometricWord } from '@/lib/passkey'

let enrolledCache: boolean | null = null
const listeners = new Set<(v: boolean) => void>()

/** Called by the "Add Face ID" screen once Privy reports the passkey enrolled. */
export function markPasskeyEnrolled(v = true) {
  enrolledCache = v
  listeners.forEach((fn) => fn(v))
}

/** Reads the enrolment from Privy (null when the user has not signed in to Privy on this page yet). */
export async function readEnrolled(appId: string): Promise<boolean | null> {
  const { adapter } = await getPrivy(appId)
  patchPrivyIframeReady(adapter)
  const mfa = installPasskeyMfa(adapter)
  if (!mfa) return null
  const s = await readPasskeyStatus(mfa.client)
  markPasskeyEnrolled(s.enrolled)
  return s.enrolled
}

export type PasskeyApproval = { on: boolean; available: boolean; enrolled: boolean; word: BiometricWord; label: string }

export function usePasskeyApproval(): PasskeyApproval {
  const { config } = useApp()
  const on = passkeyFeatureOn(config)
  const [available, setAvailable] = useState(false)
  const [enrolled, setEnrolled] = useState(enrolledCache ?? false)
  const [word, setWord] = useState<BiometricWord>('Face ID')

  useEffect(() => {
    if (!on) return
    let live = true
    setWord(biometricWord())
    listeners.add(setEnrolled)
    isPasskeyAvailable().then((v) => live && setAvailable(v))
    if (enrolledCache === null && config?.privyAppId) readEnrolled(config.privyAppId).catch(() => null)
    return () => {
      live = false
      listeners.delete(setEnrolled)
    }
  }, [on, config?.privyAppId])

  return { on, available, enrolled, word, label: approveLabel({ featureOn: on, available, enrolled, word }) }
}
