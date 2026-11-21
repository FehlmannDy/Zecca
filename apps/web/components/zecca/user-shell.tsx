'use client'
// The signed-in user space: glass backdrop, top bar, one column with the bottom dock on a phone,
// side dock on wide screens. Sends people without a finished sign-up to /app/signup. When GET /v1/config fails, every
// screen in it shows the problem and Retry (UI.md §6) instead of waiting for ever.
import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LogOut } from 'lucide-react'
import { ConfigProblem } from '@/components/send/config-problem'
import { useApp } from '@/lib/app'
import { sessionStore, useSession } from '@/lib/session'
import { Avatar, Skeleton } from './bits'
import { BottomDock, SideDock } from './bottom-dock'
import { GlassRoot } from './glass'
import { SpaceSwitch } from './space-switch'
import { hasSpaceSwitch } from './space-switch-model'
import { Logo } from './wordmark'

export function useHydrated() {
  const [h, setH] = useState(false)
  useEffect(() => setH(true), [])
  return h
}

const CARD_KEY = 'zecca.dock.card'

export function UserShell({ children }: { children: ReactNode }) {
  const session = useSession()
  const hydrated = useHydrated()
  const router = useRouter()
  const { api, config, configError, signOut } = useApp()
  const user = session?.user
  // The dock keeps the last known Card tab while the config loads, so the tabs do not shift under the thumb.
  const [lastCard, setLastCard] = useState(false)
  useEffect(() => {
    try {
      setLastCard(localStorage.getItem(CARD_KEY) === '1')
    } catch {
      /* storage blocked: start without the Card tab */
    }
  }, [])
  useEffect(() => {
    if (!config) return
    try {
      localStorage.setItem(CARD_KEY, config.features.card ? '1' : '0')
    } catch {
      /* storage blocked */
    }
  }, [config])

  useEffect(() => {
    if (hydrated && !user) router.replace('/app/signup')
  }, [hydrated, user, router])

  // Keep the stored user fresh (tier, roles).
  useEffect(() => {
    if (!user) return
    api
      .call('me')
      .then((me) => sessionStore().update({ user: me }))
      .catch(() => {})
  }, [api, user?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const cardOn = config ? !!config.features.card : lastCard
  return (
    <GlassRoot>
      <div className="mx-auto w-full max-w-[1120px] px-4 pb-32 pt-[max(16px,env(safe-area-inset-top))] lg:pb-12 lg:pl-28 lg:pr-8">
        <header className="flex h-14 items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <Link href="/app" aria-label="Zecca home" className="inline-flex min-h-11 items-center rounded-[10px]">
              <Logo className={hasSpaceSwitch(user) ? 'max-sm:[&>span]:hidden' : undefined} />
            </Link>
            <SpaceSwitch user={user} />
          </div>
          {user ? (
            <div className="flex items-center gap-2">
              <span className="hidden text-right sm:block">
                <span className="block text-[14px] font-[650] leading-tight">{user.displayName}</span>
                <span className="block text-[12.5px] text-muted">@{user.handle}</span>
              </span>
              <Avatar name={user.displayName} size={38} />
              <button
                type="button"
                onClick={async () => {
                  await signOut()
                  router.replace('/app/signup')
                }}
                className="grid size-11 place-items-center rounded-full text-muted hover:bg-ink/5 hover:text-ink"
                aria-label="Sign out"
                title="Sign out"
              >
                <LogOut className="size-[18px]" aria-hidden="true" />
              </button>
            </div>
          ) : (
            <Skeleton className="size-10 rounded-full" />
          )}
        </header>
        <main className="pt-3">{!user ? <ShellSkeleton /> : configError && !config ? <ConfigProblem /> : children}</main>
      </div>
      {user && (
        <>
          <div className="lg:hidden">
            <BottomDock cardOn={cardOn} />
          </div>
          <div className="fixed left-6 top-1/2 z-30 hidden -translate-y-1/2 lg:block">
            <SideDock cardOn={cardOn} />
          </div>
        </>
      )}
    </GlassRoot>
  )
}

function ShellSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-40 w-full rounded-[20px]" />
      <Skeleton className="h-24 w-full rounded-[20px]" />
      <Skeleton className="h-64 w-full rounded-[20px]" />
    </div>
  )
}
