'use client'
// Layout for /app/send, /app/request and /app/activity: the shared user shell, and for someone not signed up yet a
// trip to sign-up that comes back here (?next=), so a "get paid" link opened on a new phone still lands on Send.
import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Skeleton } from '@/components/zecca/bits'
import { GlassRoot } from '@/components/zecca/glass'
import { UserShell, useHydrated } from '@/components/zecca/user-shell'
import { useSession } from '@/lib/session'

export function SpaceGate({ children }: { children: ReactNode }) {
  const session = useSession()
  const hydrated = useHydrated()
  const router = useRouter()
  const signedUp = !!session?.user

  useEffect(() => {
    if (!hydrated || signedUp) return
    router.replace(`/app/signup?next=${encodeURIComponent(window.location.pathname + window.location.search)}`)
  }, [hydrated, signedUp, router])

  if (hydrated && signedUp) return <UserShell>{children}</UserShell>
  return (
    <GlassRoot>
      <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-4 px-4 pt-[max(16px,env(safe-area-inset-top))]" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-14 w-32" />
        <Skeleton className="h-40 w-full rounded-[20px]" />
        <Skeleton className="h-64 w-full rounded-[20px]" />
      </div>
    </GlassRoot>
  )
}
