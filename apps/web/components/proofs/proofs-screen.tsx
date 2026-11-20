'use client'
// Proofs (UI.md §5.10): the activity list with checkboxes, then "Create statement" opens the signed, printable page.
// Hidden when FEATURE_PROOFS is off (back to home).
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { Activity } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { isApiError } from '@/lib/api'
import { ActivityRow, ActivityRowSkeleton } from '@/components/zecca/activity-row'
import { Button, EmptyState } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { MAX_LINES, selectable, toggle, toggleAll } from './selection'

const PAGE = 50

export function ProofsScreen() {
  const { api, config } = useApp()
  const router = useRouter()
  const off = !!config && !config.features.proofs

  const [items, setItems] = useState<Activity[]>([])
  const [cursor, setCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  useEffect(() => {
    if (off) router.replace('/app')
  }, [off, router])

  const load = async (after?: string) => {
    setLoading(true)
    setLoadError(null)
    try {
      const page = await api.call('activity', { query: { limit: PAGE, ...(after ? { cursor: after } : {}) } })
      setItems((prev) => (after ? [...prev, ...page.items.filter((a) => !prev.some((p) => p.id === a.id))] : page.items))
      setCursor(page.nextCursor)
    } catch (e) {
      setLoadError(isApiError(e) || e instanceof Error ? e.message : 'Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (config?.features.proofs) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, config?.features.proofs])

  const done = useMemo(() => selectable(items), [items])
  const allOn = done.length > 0 && done.slice(0, MAX_LINES).every((a) => sel.has(a.id))

  const create = async () => {
    if (sel.size === 0 || busy) return
    setBusy(true)
    setCreateError(null)
    try {
      const ids = done.filter((a) => sel.has(a.id)).map((a) => a.id)
      const r = await api.call('disclosureCreate', { body: { activityIds: ids } })
      router.push(`/statement/${encodeURIComponent(r.id)}`)
    } catch (e) {
      setCreateError(isApiError(e) || e instanceof Error ? e.message : 'Something went wrong. Try again.')
      setBusy(false)
    }
  }

  if (!config || off) return <ListSkeleton />

  return (
    <div className="mx-auto max-w-[640px] space-y-4">
      <div>
        <h1 className="text-[26px] font-[720] tracking-[-0.02em]">Statements</h1>
        <p className="mt-1 text-[15px] text-muted">
          Pick the payments to put on a statement. Zecca signs it, and anyone can check each line on the public ledger.
        </p>
      </div>

      <Panel
        title="Your payments"
        subtitle={done.length ? `${sel.size} of ${done.length} selected` : undefined}
        action={
          done.length > 0 ? (
            <Button variant="ghost" className="min-h-11 px-3 text-[14px]" onClick={() => setSel((s) => toggleAll(s, done))}>
              {allOn ? 'Clear' : 'Select all'}
            </Button>
          ) : undefined
        }
      >
        {loading && items.length === 0 ? (
          <ListSkeleton />
        ) : loadError && items.length === 0 ? (
          <div className="flex flex-col items-start gap-3 py-4">
            <p className="text-[15px] text-alert" role="alert">
              {loadError}
            </p>
            <Button variant="secondary" onClick={() => load()}>
              Try again
            </Button>
          </div>
        ) : done.length === 0 ? (
          <EmptyState title="Nothing to put on a statement yet. Completed payments show up here." />
        ) : (
          <ul className="-mx-2" aria-label="Completed payments">
            {done.map((a) => (
              <li key={a.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-[14px] pl-2 transition-colors duration-150 hover:bg-ink/[0.04] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--brass)]">
                  <input
                    type="checkbox"
                    className="size-5 shrink-0 accent-[var(--brass)] focus:outline-none"
                    checked={sel.has(a.id)}
                    onChange={() => setSel((s) => toggle(s, a.id))}
                  />
                  <ActivityRow activity={a} className="flex-1" />
                </label>
              </li>
            ))}
          </ul>
        )}
        {cursor && (
          <div className="pt-2">
            <Button variant="secondary" className="w-full" disabled={loading} onClick={() => load(cursor)}>
              {loading ? 'Loading…' : 'Show older payments'}
            </Button>
          </div>
        )}
        {items.length > done.length && <p className="pt-3 text-[13px] text-muted">Payments still on their way can go on a statement once they are complete.</p>}
      </Panel>

      <div className="sticky bottom-24 z-10 space-y-2 lg:bottom-6">
        {createError && (
          <p className="rounded-[14px] border border-alert/30 bg-surface px-4 py-3 text-[14px] text-alert" role="alert">
            {createError}
          </p>
        )}
        <Button className="w-full shadow-[0_8px_24px_rgba(0,0,0,0.12)]" disabled={sel.size === 0 || busy} onClick={create}>
          {busy ? 'Signing your statement…' : sel.size > 0 ? `Create statement (${sel.size})` : 'Create statement'}
        </Button>
      </div>
    </div>
  )
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <ActivityRowSkeleton />
      <ActivityRowSkeleton />
      <ActivityRowSkeleton />
    </div>
  )
}
