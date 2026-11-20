'use client'
// Sign-up page wrapper: people who were already set up when they arrived go home; everyone else gets the flow
// on the paper backdrop (finishing sign-up here does not redirect, so "You're set" stays on screen).
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { User } from '@zecca/contracts'
import { safeNextPath } from '@/lib/next-path'
import { sessionStore } from '@/lib/session'
import { GlassBackdrop } from './glass'
import { SignupFlow } from './signup-flow'

export function SignupGate({ business = false, onFinished }: { business?: boolean; onFinished?: (user: User) => void }) {
  const router = useRouter()
  const [arrival, setArrival] = useState<'unknown' | 'new' | 'signed-up'>('unknown')
  const [next, setNext] = useState('/app')
  useEffect(() => {
    const home = safeNextPath(new URLSearchParams(window.location.search).get('next'))
    setNext(home)
    const user = sessionStore().get()?.user
    if (user) {
      setArrival('signed-up')
      router.replace(business && user.role.includes('merchant') ? '/merchant' : home)
    } else setArrival('new')
  }, [business, router])
  return (
    <div className="relative min-h-svh">
      <GlassBackdrop />
      {arrival === 'new' && <SignupFlow business={business} homeHref={next} onFinished={onFinished} />}
    </div>
  )
}
