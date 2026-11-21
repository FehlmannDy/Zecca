'use client'
// The card screen (UI.md §5.10), a showpiece: the card, "Card balance", "Load card", "Freeze card", the model in one
// line, the demo shop link, the live "Card payments" list (card.authorization events) with a receipt per payment,
// and the sandbox small print. Tier 0 sees the locked state with the way to the identity screen (SPEC §4.8).
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ArrowUpRight, CreditCard, Lock, Plus, RotateCw, Snowflake } from 'lucide-react'
import type { CardAuthorization, CardSecret, ZeccaEvent } from '@zecca/contracts'
import { CardDetails } from '@zecca/contracts'
import type { z } from 'zod'
import { Amount } from '@/components/zecca/amount'
import { Avatar, Button, EmptyState, Skeleton } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { isApiError } from '@/lib/api'
import { useApp } from '@/lib/app'
import { useLiveEvents, useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/cn'
import { CardReceipt } from './card-receipt'
import { CardVisual } from './card-visual'
import { authLine, latestOnly, SECRET_SHOW_MS, upsertAuthorization } from './card-logic'
import { LoadSheet } from './load-sheet'

type Details = z.infer<typeof CardDetails>

const MODEL_LINE = 'Move money to your card once, then every purchase is instant.'
const SMALL_PRINT = 'Sandbox card. It works with test purchases only.'

const SLIDE = `@keyframes zc-slide-in { from { opacity: 0; transform: translateY(-8px) } to { opacity: 1; transform: none } }`

export function CardScreen() {
  const { api, config } = useApp()
  const session = useSession()
  const tier = session?.user?.tier
  const on = !!config?.features.card
  const verifyHref = config?.features.identity ? '/app/identity' : undefined

  if (!config) return <ScreenSkeleton />
  if (!on)
    return (
      <Panel>
        <EmptyState title="The card is not available yet." action={<Link href="/app" className="inline-flex min-h-11 items-center rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[650]">Go to home</Link>} />
      </Panel>
    )
  if (tier !== 1) return <Locked verifyHref={verifyHref} holder={session?.user?.displayName} />
  return <CardHome api={api} verifyHref={verifyHref} holder={session?.user?.displayName} />
}

function CardHome({ api, verifyHref, holder }: { api: ReturnType<typeof useApp>['api']; verifyHref?: string; holder?: string }) {
  const { config } = useApp()
  const card = useResource<Details | null>(
    () =>
      api.call('cardGet').catch((e) => {
        if (isApiError(e) && e.status === 404 && e.code === 'not_found') return null
        throw e
      }),
    [api],
  )
  const balance = useResource(() => api.call('balance'), [api])
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [receipt, setReceipt] = useState<CardAuthorization | null>(null)
  const [loadOpen, setLoadOpen] = useState(false)
  const [busy, setBusy] = useState<'create' | 'freeze' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [announce, setAnnounce] = useState('')

  // Flip: details fetched when shown, dropped when hidden (30 s).
  const [flipped, setFlipped] = useState(false)
  const [secret, setSecret] = useState<CardSecret | null>(null)
  const [secretError, setSecretError] = useState<string | null>(null)
  const [left, setLeft] = useState(0)
  const hideAt = useRef(0)
  // An answer that arrives after Hide (or after a newer flip) is dropped: the details are never kept unseen.
  const secretReq = useRef(latestOnly())

  const hide = useCallback(() => {
    secretReq.current.cancel()
    setFlipped(false)
    setSecret(null)
    setSecretError(null)
  }, [])
  const toggle = useCallback(() => {
    if (flipped) return hide()
    setFlipped(true)
    setSecretError(null)
    hideAt.current = Date.now() + SECRET_SHOW_MS
    setLeft(SECRET_SHOW_MS / 1000)
    const live = secretReq.current.begin()
    api
      .call('cardSecret')
      .then((s) => live() && setSecret(s))
      .catch((e) => live() && setSecretError(e instanceof Error ? e.message : 'The card details could not be shown. Try again.'))
  }, [flipped, hide, api])
  useEffect(() => {
    if (!flipped) return
    const id = setInterval(() => {
      const s = Math.max(0, Math.ceil((hideAt.current - Date.now()) / 1000))
      setLeft(s)
      if (s === 0) hide()
    }, 250)
    return () => clearInterval(id)
  }, [flipped, hide])

  const onEvent = useCallback(
    (e: ZeccaEvent) => {
      if (e.type === 'card.authorization') {
        card.setData((d) => (d ? { ...d, authorizations: upsertAuthorization(d.authorizations, e.data) } : d))
        setFresh((s) => new Set(s).add(e.data.id))
        setAnnounce(e.data.approved ? `${e.data.merchant}, ${e.data.status === 'authorised' ? 'approved' : e.data.status}` : `${e.data.merchant}, declined, not enough on the card`)
        card.refresh()
      }
      if (e.type === 'balance.updated') {
        balance.setData(e.data)
        if (e.data.cardMinor !== undefined) card.setData((d) => (d ? { ...d, balanceMinor: e.data.cardMinor! } : d))
      }
      if (e.type === 'intent.updated' && e.data.kind === 'card_load') card.refresh()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const onPoll = useCallback(() => {
    card.refresh()
    balance.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useLiveEvents(onEvent, onPoll)

  const create = async () => {
    setBusy('create')
    setActionError(null)
    try {
      await api.call('cardCreate')
      card.reload()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(null)
    }
  }
  const setFrozen = async (frozen: boolean) => {
    setBusy('freeze')
    setActionError(null)
    try {
      const c = await api.call(frozen ? 'cardFreeze' : 'cardUnfreeze')
      card.setData((d) => (d ? { ...d, state: c.state } : d))
      setAnnounce(frozen ? 'Card frozen' : 'Card unfrozen')
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(null)
    }
  }

  if (card.loading) return <ScreenSkeleton />
  if (card.error && !card.data)
    return (
      <Panel>
        <div className="flex flex-col items-start gap-3 py-2" role="alert">
          <p className="text-[15px]">{card.error}</p>
          <Button variant="secondary" onClick={card.reload} className="min-h-11">
            <RotateCw className="size-4" aria-hidden="true" /> Retry
          </Button>
        </div>
      </Panel>
    )

  const d = card.data
  if (!d)
    return (
      <div className="flex flex-col gap-5">
        <CardVisual card={{ last4: '0000', expMonth: 1, expYear: 2030, state: 'OPEN', holderName: holder ?? '' }} flipped={false} locked className="opacity-90" />
        <Panel>
          <h1 className="text-[22px] font-[740] tracking-[-0.025em]">Your Zecca card</h1>
          <p className="mt-2 text-[15px] text-muted">A virtual card for paying online. {MODEL_LINE}</p>
          <Button className="mt-5 w-full" onClick={create} busy={busy === 'create'}>
            <CreditCard className="size-5" aria-hidden="true" /> {busy === 'create' ? 'Creating your card…' : 'Get my card'}
          </Button>
          {actionError && (
            <p className="mt-3 text-[14px] text-alert" role="alert">
              {actionError}
            </p>
          )}
        </Panel>
        <p className="text-center text-[12.5px] text-muted">{SMALL_PRINT}</p>
      </div>
    )

  const frozen = d.state !== 'OPEN'
  const auths = d.authorizations
  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] lg:items-start lg:gap-6">
      <style>{SLIDE}</style>
      <div className="flex flex-col gap-4 lg:sticky lg:top-6">
        <h1 className="sr-only">Card</h1>
        <CardVisual card={d} secret={secret} secretError={secretError} flipped={flipped} onToggle={toggle} secondsLeft={left} />
        <p className="text-center text-[13px] text-muted">{flipped ? 'Tap the card to hide the details.' : 'Tap the card to see its number.'}</p>

        <Panel aria-labelledby="card-balance-label">
          <span id="card-balance-label" className="label-caps text-muted">
            Card balance
          </span>
          <div className="mt-2" aria-live="polite">
            <Amount minor={d.balanceMinor} size="xl" />
          </div>
          <p className="mt-2 text-[14px] text-muted">{MODEL_LINE}</p>
          <div className="mt-5 flex flex-col gap-3">
            <Button className="w-full" onClick={() => setLoadOpen(true)}>
              <Plus className="size-5" aria-hidden="true" /> Load card
            </Button>
            <FreezeSwitch frozen={frozen} disabled={busy === 'freeze'} onChange={setFrozen} />
          </div>
          {frozen && <p className="mt-3 text-[13.5px] text-muted">Frozen. Purchases are declined until you unfreeze it.</p>}
          {actionError && (
            <p className="mt-3 text-[14px] text-alert" role="alert">
              {actionError}
            </p>
          )}
        </Panel>

        {config?.demoMode && (
          <Link href="/demo/shop" className="group flex min-h-14 items-center justify-between rounded-[18px] border border-line bg-surface/80 px-4 text-[15px] font-[650] hover:border-ink/30">
            Try your card in the demo shop
            <ArrowUpRight className="size-5 text-muted transition-transform duration-150 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" aria-hidden="true" />
          </Link>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <Panel title="Card payments" aria-label="Card payments">
          {auths.length === 0 ? (
            <EmptyState title="No card payments yet." action={config?.demoMode ? <Link href="/demo/shop" className="inline-flex min-h-11 items-center rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[650]">Open the demo shop</Link> : undefined} />
          ) : (
            <ul className="-mx-2 flex flex-col">
              {auths.map((a) => (
                <li key={a.id} className={cn(fresh.has(a.id) && 'motion-safe:animate-[zc-slide-in_260ms_ease-out]')}>
                  <PaymentRow a={a} onOpen={() => setReceipt(a)} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <p className="text-center text-[12.5px] text-muted lg:text-left">{SMALL_PRINT}</p>
      </div>

      <LoadSheet
        open={loadOpen}
        onClose={() => setLoadOpen(false)}
        availableMinor={balance.data?.availableMinor ?? null}
        limits={config?.limits}
        verifyHref={verifyHref}
        onLoaded={() => {
          balance.refresh()
          setTimeout(() => card.refresh(), 1500)
        }}
      />
      <CardReceipt auth={receipt ? (auths.find((x) => x.id === receipt.id) ?? receipt) : null} last4={d.last4} onClose={() => setReceipt(null)} />
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announce}
      </p>
    </div>
  )
}

function PaymentRow({ a, onOpen }: { a: CardAuthorization; onOpen: () => void }) {
  const declined = a.status === 'declined'
  const back = a.status === 'voided' || a.status === 'refunded'
  return (
    <button type="button" onClick={onOpen} className="flex min-h-16 w-full items-center gap-3 rounded-[14px] px-2 py-2.5 text-left transition-colors duration-150 hover:bg-ink/[0.04]">
      <Avatar name={a.merchant} business />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-[660]">{a.merchant}</span>
        <span className={cn('mt-0.5 block truncate text-[13px]', declined ? 'text-alert' : 'text-muted')}>
          {authLine(a)} · {new Date(a.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
        </span>
      </span>
      <Amount minor={a.amountMinor} size="md" direction={a.status === 'refunded' ? 'in' : undefined} tone={declined || a.status === 'voided' ? 'muted' : undefined} className={cn((declined || back) && a.status !== 'refunded' && 'line-through decoration-1')} />
    </button>
  )
}

function FreezeSwitch({ frozen, disabled, onChange }: { frozen: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center gap-2.5 rounded-[14px] border border-line bg-surface px-4 text-[15px] font-[650]">
      <Snowflake className="size-4 text-muted" aria-hidden="true" />
      <span className="flex-1">Freeze card</span>
      <button
        type="button"
        role="switch"
        aria-checked={frozen}
        aria-label="Freeze card"
        // Busy is aria-disabled, not disabled: the switch keeps keyboard focus while the change is saved.
        aria-disabled={disabled || undefined}
        aria-busy={disabled || undefined}
        onClick={() => !disabled && onChange(!frozen)}
        className={cn('relative h-7 w-12 rounded-full transition-colors duration-150 aria-disabled:opacity-50', frozen ? 'bg-ink' : 'bg-line')}
      >
        <span className={cn('absolute top-1 left-1 size-5 rounded-full bg-surface shadow transition-transform duration-150', frozen && 'translate-x-5')} aria-hidden="true" />
      </button>
    </label>
  )
}

function Locked({ verifyHref, holder }: { verifyHref?: string; holder?: string }) {
  return (
    <div className="flex flex-col gap-5">
      <CardVisual card={{ last4: '0000', expMonth: 1, expYear: 2030, state: 'OPEN', holderName: holder ?? '' }} flipped={false} locked className="opacity-60" />
      <Panel>
        <span className="inline-flex size-10 items-center justify-center rounded-full border border-line" aria-hidden="true">
          <Lock className="size-[18px]" />
        </span>
        <h1 className="mt-3 text-[22px] font-[740] tracking-[-0.025em]">Verify your identity to get a card.</h1>
        <p className="mt-2 text-[15px] text-muted">The card is for verified accounts. {MODEL_LINE}</p>
        {verifyHref ? (
          <Link href={verifyHref} className="mt-5 inline-flex min-h-12 w-full items-center justify-center rounded-[14px] bg-ink px-5 text-[15px] font-[680] text-paper hover:opacity-90">
            Verify your identity
          </Link>
        ) : (
          <>
            <Button disabled className="mt-5 w-full" aria-describedby="verify-soon">
              Verify your identity
            </Button>
            <p id="verify-soon" className="mt-2 text-center text-[13px] text-muted">
              Identity checks are not available yet.
            </p>
          </>
        )}
      </Panel>
      <p className="text-center text-[12.5px] text-muted">{SMALL_PRINT}</p>
    </div>
  )
}

function ScreenSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="mx-auto aspect-[85.6/54] w-full max-w-[420px] rounded-[22px]" />
      <Skeleton className="h-40 w-full rounded-[20px]" />
      <Skeleton className="h-56 w-full rounded-[20px]" />
    </div>
  )
}
