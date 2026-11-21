'use client'
// "Add Face ID" (SPEC §4.11): link a passkey to the Privy account, enrol it for transactions. Offered after sign-up
// with FEATURE_PASSKEY on. The passkey is not the account's key and signs nothing; it proves to Privy that the owner
// is present, and Privy's signer then signs. Card purchases never ask for it.
// ?next=/app is where "Not now" and "Done" go. ?preview=1 shows the screen in demo mode with the flag off (phone check).
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { FingerprintPattern, ScanFace } from 'lucide-react'
import { useApp } from '@/lib/app'
import { safeNextPath } from '@/lib/next-path'
import { getPrivy } from '@/lib/wallet/privy'
import {
  biometricWord,
  enrollPasskeyMfa,
  installPasskeyMfa,
  isPasskeyAvailable,
  linkPasskey,
  passkeyFeatureOn,
  patchPrivyIframeReady,
  readPasskeyStatus,
  type BiometricWord,
} from '@/lib/passkey'
import { Button, GlassBackdrop, Logo, Skeleton } from '@/components/zecca'
import { markPasskeyEnrolled } from './use-passkey'

type Phase = 'loading' | 'off' | 'unavailable' | 'offer' | 'adding' | 'done' | 'error'

export function AddFaceId() {
  const { config } = useApp()
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const [word, setWord] = useState<BiometricWord>('Face ID')
  const [next, setNext] = useState('/app')

  useEffect(() => {
    if (!config) return
    const q = new URLSearchParams(window.location.search)
    setNext(safeNextPath(q.get('next')))
    setWord(biometricWord())
    const preview = config.demoMode && config.signerMode === 'privy' && q.get('preview') === '1'
    if (!passkeyFeatureOn(config) && !preview) return setPhase('off')
    let live = true
    ;(async () => {
      if (!(await isPasskeyAvailable())) return live && setPhase('unavailable')
      const status = await privyStatus(config.privyAppId).catch(() => null)
      if (live) setPhase(status?.enrolled ? 'done' : 'offer')
    })()
    return () => {
      live = false
    }
  }, [config])

  async function add() {
    if (!config?.privyAppId) return
    setPhase('adding')
    setError('')
    try {
      const { manager, adapter } = await getPrivy(config.privyAppId)
      patchPrivyIframeReady(adapter)
      if (!manager.account) await manager.reconnect()
      // The handler first: enrolment itself may ask Privy for a passkey check.
      const mfa = installPasskeyMfa(adapter)
      if (!mfa) throw new Error('Sign in again to add Face ID.')
      const status = await readPasskeyStatus(mfa.client)
      if (status.credentialIds.length === 0) await linkPasskey(mfa.client)
      const after = await enrollPasskeyMfa(mfa.client)
      if (!after.enrolled) throw new Error("That didn't work. Try again.")
      markPasskeyEnrolled()
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again.")
      setPhase('error')
    }
  }

  const Icon = word === 'Face ID' ? ScanFace : FingerprintPattern
  const thing = word === 'Face ID' ? 'Face ID' : 'your fingerprint'
  const add_ = word === 'Face ID' ? 'Add Face ID' : 'Add fingerprint'

  return (
    <div className="relative min-h-svh">
      <GlassBackdrop />
      <div className="mx-auto flex min-h-svh w-full max-w-[440px] flex-col px-5 pb-10 pt-6 lg:max-w-[520px] lg:justify-center">
        <header>
          <Logo />
        </header>
        <main className="mt-12 flex flex-1 flex-col lg:flex-none">
          {phase === 'loading' && (
            <div className="flex flex-col gap-4" aria-busy="true">
              <Skeleton className="size-14 rounded-full" />
              <Skeleton className="h-9 w-4/5" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}

          {(phase === 'offer' || phase === 'adding' || phase === 'error') && (
            <section className="flex flex-col">
              <Icon className="size-14 text-ink" strokeWidth={1.25} aria-hidden="true" />
              <h1 className="mt-6 text-[30px] font-[760] leading-[1.1] tracking-[-0.03em]">Approve payments with {thing}.</h1>
              <p className="mt-3 text-[16px] leading-relaxed text-muted">
                Your phone keeps a passkey that only you can unlock. It proves to Zecca&apos;s key provider that it&apos;s you; it never leaves your phone.
              </p>
              <p className="mt-3 text-[14px] text-muted">Card purchases never ask for it.</p>
              {phase === 'error' && (
                <p className="mt-6 text-[15px] text-alert" role="alert">
                  {error}
                </p>
              )}
              <div className="mt-10 flex flex-col gap-2">
                <Button onClick={add} busy={phase === 'adding'}>
                  {phase === 'adding' ? 'Waiting for your phone…' : phase === 'error' ? 'Try again' : add_}
                </Button>
                <Button variant="ghost" onClick={() => router.replace(next)} disabled={phase === 'adding'}>
                  Not now
                </Button>
              </div>
            </section>
          )}

          {phase === 'done' && (
            <section className="flex flex-col">
              <Icon className="size-14 text-in" strokeWidth={1.25} aria-hidden="true" />
              <h1 className="mt-6 text-[30px] font-[760] leading-[1.1] tracking-[-0.03em]">{word === 'Face ID' ? 'Face ID is on.' : 'Fingerprint is on.'}</h1>
              <p className="mt-3 text-[16px] leading-relaxed text-muted">Your phone asks for {thing} when you approve a payment.</p>
              <Button className="mt-10" onClick={() => router.replace(next)}>
                Done
              </Button>
            </section>
          )}

          {(phase === 'off' || phase === 'unavailable') && (
            <section className="flex flex-col">
              <h1 className="text-[26px] font-[740] leading-[1.15] tracking-[-0.025em]">
                {phase === 'off' ? "This isn't available yet." : "This phone can't do this here."}
              </h1>
              <p className="mt-3 text-[16px] text-muted">You approve payments with the Approve button.</p>
              <Button className="mt-10" onClick={() => router.replace(next)}>
                Go to home
              </Button>
            </section>
          )}
          <p className="sr-only" aria-live="polite">
            {phase === 'done' ? `${word} is on` : phase === 'adding' ? 'Waiting for your phone' : ''}
          </p>
        </main>
      </div>
    </div>
  )
}

async function privyStatus(appId: string | undefined) {
  if (!appId) return null
  const { manager, adapter } = await getPrivy(appId)
  patchPrivyIframeReady(adapter)
  if (!manager.account) await manager.reconnect().catch(() => null)
  const mfa = installPasskeyMfa(adapter)
  return mfa ? readPasskeyStatus(mfa.client) : null
}
