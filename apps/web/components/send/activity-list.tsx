'use client'
// All activity (/app/activity): newest first, cursor pagination ("Show more"), live from activity.created and
// intent.updated; a clock while pending, "+" for money received (ActivityRow). Each row opens its detail.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { RotateCw } from 'lucide-react'
import type { Activity, ZeccaEvent } from '@zecca/contracts'
import { ActivityRow, ActivityRowSkeleton } from '@/components/zecca/activity-row'
import { Button, EmptyState } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { useApp } from '@/lib/app'
import { useLiveEvents } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { rememberActivities } from './activity-cache'
import { applyIntent, mergeActivity } from './ledger-view'

const PAGE = 20

export function ActivityList() {
  const { api, config } = useApp()
  const userId = useSession()?.user?.id
  const router = useRouter()
  const [items, setItems] = useState<Activity[] | null>(null)
  const [cursor, setCursor] = useState<string | undefined>()
  const [error, setError] = useState<string | null>(null)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setError(null)
    api
      .call('activity', { query: { limit: PAGE } })
      .then((p) => {
        if (!live) return
        setItems(p.items)
        setCursor(p.nextCursor)
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Something went wrong. Try again.'))
    return () => {
      live = false
    }
  }, [api, attempt])

  useEffect(() => {
    if (items && userId) rememberActivities(userId, items)
  }, [items, userId])

  const onEvent = useCallback((e: ZeccaEvent) => {
    if (e.type === 'activity.created') setItems((l) => (l ? mergeActivity(l, e.data) : l))
    if (e.type === 'intent.updated') setItems((l) => l?.map((a) => applyIntent(a, e.data)) ?? l)
  }, [])
  const onPoll = useCallback(() => {
    api
      .call('activity', { query: { limit: PAGE } })
      .then((p) => setItems((l) => (l ? [...p.items].reverse().reduce(mergeActivity, l) : p.items)))
      .catch(() => {})
  }, [api])
  useLiveEvents(onEvent, onPoll)

  async function more() {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const p = await api.call('activity', { query: { cursor, limit: PAGE } })
      setItems((l) => {
        const have = new Set((l ?? []).map((a) => a.id))
        return [...(l ?? []), ...p.items.filter((a) => !have.has(a.id))]
      })
      setCursor(p.nextCursor)
    } catch (e) {
      setMoreError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
    } finally {
      setLoadingMore(false)
    }
  }

  const open = (a: Activity) => router.push(`/app/activity/${encodeURIComponent(a.id)}`)

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <h1 className="px-1 text-[22px] font-[740] tracking-[-0.02em]">Activity</h1>
      <Panel aria-label="All activity">
        {error && !items ? (
          <div className="flex flex-col items-start gap-3 py-3" role="alert">
            <p className="text-[15px] text-ink">{error}</p>
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)} className="min-h-11">
              <RotateCw className="size-4" aria-hidden="true" /> Retry
            </Button>
          </div>
        ) : !items ? (
          <div aria-busy="true" aria-label="Loading activity">
            {Array.from({ length: 6 }, (_, i) => (
              <ActivityRowSkeleton key={i} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="Nothing yet. Top up to get started."
            action={
              (config?.features.ramp || config?.demoMode) ? (
                <Link href="/app/topup" className="inline-flex min-h-11 items-center rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[650]">
                  Top up
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            <ul className="-mx-2 flex flex-col">
              {items.map((a) => (
                <li key={a.id}>
                  <ActivityRow activity={a} onOpen={open} />
                </li>
              ))}
            </ul>
            {cursor && (
              <div className="mt-3 flex flex-col items-center gap-2">
                {moreError && (
                  <p className="text-[14px] text-alert" role="alert">
                    {moreError}
                  </p>
                )}
                <Button variant="secondary" onClick={more} disabled={loadingMore} aria-busy={loadingMore || undefined}>
                  {loadingMore ? 'Loading…' : 'Show more'}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  )
}
