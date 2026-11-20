'use client'
// Sign-up page wrapper: people who were already set up when they arrived go home; everyone else gets the flow
// on the paper backdrop (finishing sign-up here does not redirect, so "You're set" stays on screen).
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { sessionStore } from '@/lib/session'
import { GlassBackdrop } from './glass'
import { SignupFlow } from './signup-flow'

export function SignupGate({ business = false }: { business?: boolean }) {
  const router = useRouter()
  const [arrival, setArrival] = useState<'unknown' | 'new' | 'signed-up'>('unknown')
  useEffect(() => {
    const user = sessionStore().get()?.user
    if (user) {
      setArrival('signed-up')
      router.replace(business && user.role.includes('merchant') ? '/merchant' : '/app')
    } else setArrival('new')
  }, [business, router])
  return (
    <div className="relative min-h-svh">
      <GlassBackdrop />
      {arrival === 'new' && <SignupFlow business={business} homeHref="/app" />}
    </div>
  )
}
