'use client'
// Activity detail (UI.md §5.6): who, how much, when, status, note; a receipt for purchases; and "What the ledger
// shows" with its two-way switch, built from the real activity (hashes, ciphertext preview) the API returned.
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Lock, RotateCw } from 'lucide-react'
import type { Activity, PublicConfig, Receipt, ZeccaEvent } from '@zecca/contracts'
import { formatUsd } from '@zecca/contracts'
import { Amount } from '@/components/zecca/amount'
import { Avatar, Button, HashChip, Skeleton } from '@/components/zecca/bits'
import { Badge, Panel } from '@/components/zecca/glass'
import { LogoMark } from '@/components/zecca/wordmark'
import { activityTitle } from '@/lib/activity'
import { type ApiClient } from '@/lib/api'
import { useApp } from '@/lib/app'
import { cn } from '@/lib/cn'
import { useLiveEvents } from '@/lib/hooks'
import { cachedActivity, rememberActivities } from './activity-cache'
import { applyIntent, findActivity, ledgerRows, statusWord, type LedgerMode, type LedgerRow } from './ledger-view'

const MAX_PAGES = 10

/** There is no GET /v1/activity/:id: walk the pages (newest first) until the row turns up. */
async function fetchActivity(api: ApiClient, id: string): Promise<Activity | null> {
  let cursor: string | undefined
  for (let n = 0; n < MAX_PAGES; n++) {
    const p = await api.call('activity', { query: { limit: 100, ...(cursor ? { cursor } : {}) } })
    rememberActivities(p.items)
    const hit = findActivity(p.items, id)
    if (hit) return hit
    if (!p.nextCursor) return null
    cursor = p.nextCursor
  }
  return null
}

const fullWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

const POOL_PAYOUT = new Set(['p2p', 'merchant', 'topup'])

export function ActivityDetail({ id }: { id: string }) {
  const { api, config } = useApp()
  const [a, setA] = useState<Activity | null>(() => cachedActivity(id) ?? null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>(a ? 'ready' : 'loading')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  const load = useCallback(
    async (quiet: boolean) => {
      try {
        const hit = await fetchActivity(api, id)
        if (hit) {
          setA(hit)
          setState('ready')
        } else if (!quiet) setState((s) => (s === 'ready' ? s : 'missing'))
      } catch (e) {
        if (quiet) return
        setError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
        setState((s) => (s === 'ready' ? s : 'error'))
      }
    },
    [api, id],
  )

  useEffect(() => {
    void load(false)
  }, [load, attempt])

  const onEvent = useCallback(
    (e: ZeccaEvent) => {
      if (e.type === 'intent.updated') setA((cur) => (cur ? applyIntent(cur, e.data) : cur))
      if (e.type === 'activity.created' && (e.data.id === id || e.data.intentId === id)) {
        setA(e.data)
        setState('ready')
      }
    },
    [id],
  )
  const onPoll = useCallback(() => void load(true), [load])
  useLiveEvents(onEvent, onPoll)

  // Safety net while a transaction is still to come: refresh every 5 s (events usually get there first).
  const waiting = !!a && a.status !== 'failed' && (!a.ledger.depositTxHash || (POOL_PAYOUT.has(a.kind) && !a.ledger.payoutTxHash))
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => void load(true), 5000)
    return () => clearInterval(t)
  }, [waiting, load])

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link href="/app/activity" className="-ml-2 grid size-11 place-items-center rounded-full text-ink hover:bg-ink/5" aria-label="All activity">
          <ArrowLeft className="size-5" aria-hidden="true" />
        </Link>
        <h1 className="text-[22px] font-[740] tracking-[-0.02em]">Details</h1>
      </div>

      {state === 'error' && !a ? (
        <Panel role="alert">
          <p className="text-[15px]">{error}</p>
          <Button variant="secondary" className="mt-3 min-h-11" onClick={() => setAttempt((n) => n + 1)}>
            <RotateCw className="size-4" aria-hidden="true" /> Retry
          </Button>
        </Panel>
      ) : state === 'missing' && !a ? (
        <Panel>
          <p className="text-[15px]">We couldn't find that payment.</p>
          <Link href="/app/activity" className="mt-3 inline-flex min-h-11 items-center rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[650]">
            See all activity
          </Link>
        </Panel>
      ) : !a ? (
        <DetailSkeleton />
      ) : (
        <>
          <Summary a={a} />
          {a.receipt && <ReceiptPanel r={a.receipt} />}
          {config && <LedgerPanel a={a} config={config} />}
        </>
      )}
    </div>
  )
}

function Summary({ a }: { a: Activity }) {
  const title = activityTitle(a)
  const word = statusWord(a)
  const tone = a.status === 'failed' ? 'alert' : a.status === 'done' ? (a.direction === 'in' ? 'in' : 'ink') : 'brass'
  return (
    <Panel className="flex flex-col items-center text-center">
      {a.counterparty || a.receipt ? (
        <Avatar name={title} size={56} business={a.counterparty?.isMerchant || !!a.receipt} />
      ) : (
        <span aria-hidden="true" className="grid size-14 place-items-center rounded-full border border-line bg-surface">
          <LogoMark className="h-6" title="" />
        </span>
      )}
      <p className="mt-3 text-[17px] font-[680]">{title}</p>
      {a.counterparty && <p className="text-[13.5px] text-muted">@{a.counterparty.handle}</p>}
      <Amount minor={a.amountMinor} size="xl" direction={a.direction} tone={a.status === 'failed' ? 'muted' : undefined} className={cn('mt-3', a.status === 'failed' && 'line-through decoration-muted')} />
      <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-[14px] text-muted">
        <Badge tone={tone}>{word}</Badge>
        <span>{fullWhen(a.at)}</span>
      </div>
      {a.note && a.kind !== 'welcome' && <p className="mt-4 max-w-[36ch] rounded-[14px] bg-paper px-4 py-2.5 text-[15px] text-ink">“{a.note}”</p>}
    </Panel>
  )
}

const RECEIPT_STATUS: Record<Receipt['status'], string> = { authorised: 'Authorised', completed: 'Completed', declined: 'Declined' }

function ReceiptPanel({ r }: { r: Receipt }) {
  return (
    <Panel title="Receipt" subtitle={r.shopName}>
      <ul className="divide-y divide-line border-y border-line">
        {r.items.map((it, i) => (
          <li key={i} className="flex items-baseline justify-between gap-3 py-2.5 text-[15px]">
            <span className="min-w-0">
              <span className="tabular text-muted">{it.qty} × </span>
              {it.name}
            </span>
            <span className="tabular shrink-0">{formatUsd(it.qty * it.unitMinor)}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-baseline justify-between py-3 text-[16px] font-[700]">
        <span>Total</span>
        <span className="tabular">{formatUsd(r.amountMinor)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[14px]">
        <dt className="text-muted">Time</dt>
        <dd className="text-right">{fullWhen(r.at)}</dd>
        <dt className="text-muted">Method</dt>
        <dd className="text-right">{r.method === 'card' ? `Card ending ${r.cardLast4 ?? '····'}` : 'Zecca balance'}</dd>
        <dt className="text-muted">Status</dt>
        <dd className="text-right">{RECEIPT_STATUS[r.status]}</dd>
        <dt className="text-muted">Reference</dt>
        <dd className="text-right font-mono text-[13px]">{r.reference}</dd>
        <dt className="text-muted">Order</dt>
        <dd className="text-right font-mono text-[13px]">{r.orderNumber}</dd>
      </dl>
    </Panel>
  )
}

function LedgerPanel({ a, config }: { a: Activity; config: PublicConfig }) {
  const [mode, setMode] = useState<LedgerMode>('you')
  const rows = ledgerRows(a, mode, { explorer: config.explorer })
  const base = useId()
  const tabs = useRef<Record<LedgerMode, HTMLButtonElement | null>>({ you: null, everyone: null })
  const who = a.counterparty ? a.counterparty.displayName.split(/\s+/)[0] : null
  const select = (m: LedgerMode) => {
    setMode(m)
    tabs.current[m]?.focus()
  }
  return (
    <Panel title="What the ledger shows">
      <div role="tablist" aria-label="Seen by" className="grid grid-cols-2 gap-1 rounded-full border border-line bg-paper p-1">
        {(['you', 'everyone'] as const).map((m) => (
          <button
            key={m}
            ref={(el) => {
              tabs.current[m] = el
            }}
            type="button"
            role="tab"
            id={`${base}-${m}`}
            aria-selected={mode === m}
            aria-controls={`${base}-panel`}
            tabIndex={mode === m ? 0 : -1}
            onClick={() => setMode(m)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') select(m === 'you' ? 'everyone' : 'you')
            }}
            className={cn('min-h-11 rounded-full text-[14px] font-[680] transition-colors duration-150', mode === m ? 'bg-ink text-paper' : 'text-muted hover:text-ink')}
          >
            {m === 'you' ? 'You' : 'Everyone else'}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-panel`} aria-labelledby={`${base}-${mode}`} className="mt-4">
        <p className="text-[14px] text-muted">
          {mode === 'you'
            ? who
              ? `What you and ${who} see.`
              : 'What you see.'
            : 'What anyone reading the public ledger sees: that a payment happened, not how much, and not who paid whom.'}
        </p>
        <dl className="mt-3 divide-y divide-line">
          {rows.map((r) => (
            <div key={r.key} className="flex min-h-14 items-center justify-between gap-4 py-2.5">
              <dt className="shrink-0 text-[14px] text-muted">{r.label}</dt>
              <dd className="min-w-0 text-right">
                <RowValue r={r} />
              </dd>
            </div>
          ))}
        </dl>
        {mode === 'everyone' && config.ledgerMode === 'mock' && (
          <p className="mt-3 text-[12.5px] text-muted">Test mode: these transactions are simulated, so the links do not open a real record.</p>
        )}
      </div>
    </Panel>
  )
}

/** "03D4E5B1B1B1B1B1" -> "03D4 E5B1 B1B1 B1B1" */
const groups = (hex: string) => hex.match(/.{1,4}/g)?.join(' ') ?? hex

function RowValue({ r }: { r: LedgerRow }) {
  switch (r.kind) {
    case 'amount':
      return <Amount minor={r.minor} direction={r.direction} />
    case 'party':
      return (
        <span className="block">
          <span className="block truncate text-[15px] font-[650]">{r.text}</span>
          {r.sub && <span className="block truncate text-[13px] text-muted">{r.sub}</span>}
        </span>
      )
    case 'text':
      return <span className="text-[15px] text-muted">{r.text}</span>
    case 'sealed':
      return (
        <span className="inline-flex max-w-full items-center gap-2 rounded-[10px] bg-sealed px-3 py-1.5 font-mono text-[13px] tracking-[0.04em] text-paper">
          <Lock className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">Sealed amount: </span>
          <span className="truncate">{r.preview ? `${groups(r.preview)}…` : 'Sealed'}</span>
        </span>
      )
    case 'hash':
      return <HashChip value={r.hash} href={r.href} label="Copy transaction" />
    case 'waiting':
      return <span className="text-[14px] text-muted">{r.text}</span>
  }
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Panel className="flex flex-col items-center gap-3">
        <Skeleton className="size-14 rounded-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-4 w-48" />
      </Panel>
      <Panel>
        <Skeleton className="h-11 w-full rounded-full" />
        <div className="mt-4 space-y-3">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </Panel>
    </div>
  )
}
