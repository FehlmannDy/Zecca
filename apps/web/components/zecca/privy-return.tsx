'use client'
// /wallet/privy: the same manager instance calls reconnect() to finish the login, then opens a session and goes
// to /app (or to sign-up when the account is new). In mock mode there is nothing to finish.
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useApp } from '@/lib/app'
import { ArchesProgress } from './arches'
import { GlassBackdrop } from './glass'
import { Logo } from './wordmark'

export function PrivyReturn() {
  const { config, completePrivyRedirect } = useApp()
  const router = useRouter()
  const [error, setError] = useState('')
  const once = useRef(false)
  useEffect(() => {
    if (!config || once.current) return
    once.current = true
    if (config.signerMode !== 'privy') {
      router.replace('/app')
      return
    }
    completePrivyRedirect()
      .then((r) => router.replace(r.user ? '/app' : '/app/signup'))
      .catch((e) => setError(e instanceof Error ? e.message : "We couldn't finish signing you in. Try again."))
  }, [config, completePrivyRedirect, router])
  return (
    <div className="relative min-h-svh">
      <GlassBackdrop />
      <div className="mx-auto flex min-h-svh max-w-[440px] flex-col px-5 py-6">
        <Logo />
        <main className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
          {error ? (
            <>
              <p className="text-[16px]" role="alert">
                {error}
              </p>
              <a href="/app/signup" className="inline-flex min-h-12 items-center rounded-[14px] bg-ink px-6 text-[15px] font-[680] text-paper">
                Try again
              </a>
            </>
          ) : (
            <>
              <ArchesProgress state="running" expectedMs={4000} label="Signing you in" />
              <p className="text-[15px] text-muted" aria-live="polite">
                Signing you in
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
