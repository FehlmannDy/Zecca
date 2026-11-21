'use client'
// Send (UI.md §5.4): "To" (handle, phone or email, resolved as you type; recent contacts below), then the amount
// and an optional note, then the approve sheet. Continue creates the transfer (POST /v1/transfers), so a limit or a
// short balance shows before anything is signed; Approve signs and submits it. /app/send?to=<handle> preselects.
// A submit whose answer was lost is followed here until it settles, never paid a second time (approve-flow.ts).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, RotateCw } from 'lucide-react'
import { formatUsd, spokenUsd, type Intent, type PreparedTx, type PublicProfile, type ZeccaEvent } from '@zecca/contracts'
import { AmountKeypad } from '@/components/zecca/amount-keypad'
import { ApproveSheet, type ApproveOutcome } from '@/components/zecca/approve-sheet'
import { Avatar, Button } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { LimitSheet } from '@/components/zecca/limit-sheet'
import { isApiError, type ApiErrorDetails, type ZeccaApiError } from '@/lib/api'
import { useApp } from '@/lib/app'
import { cn } from '@/lib/cn'
import { useLiveEvents, useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { signAndSubmit } from '@/lib/wallet/sign-and-submit'
import { approveTransfer, type Transfer } from './approve-flow'
import { ConfigProblem } from './config-problem'
import { RecipientRow, RecipientRowSkeleton } from './recipient-row'
import { sendToParam } from './request-link'
import { createResolver, lookupQuery, type ResolverState } from './resolver'
import { checkSendAmount, followText, matchContacts, recipientShortName, sendProblemOf, sentTitle, type SendProblem } from './send-rules'

const FollowCtx = createContext<{ intent: Intent | null; to: PublicProfile | null }>({ intent: null, to: null })

/** Under "Sent.": where the money is now, from intent.updated. */
function FollowLine() {
  const { intent, to } = useContext(FollowCtx)
  if (!intent || !to) return null
  const f = followText(intent, to)
  return <span className={f.tone === 'alert' ? 'text-alert' : undefined}>{f.text}</span>
}

const SENT = new Set<Intent['status']>(['submitted', 'received', 'paid_out'])

/** In place of the keypad while a payment whose answer was lost settles: it updates by itself (intent.updated). */
function StillSending({ amountMinor, message, onAgain, onDetails }: { amountMinor: number; message: string; onAgain: () => void; onDetails: () => void }) {
  const { intent, to } = useContext(FollowCtx)
  const router = useRouter()
  if (!intent || !to) return null
  const sent = SENT.has(intent.status)
  const over = intent.status === 'failed' || intent.status === 'expired'
  return (
    <Panel className="flex flex-col items-center text-center" aria-live="polite">
      <p className="mt-1 text-[17px] font-[680] tracking-[-0.01em]">
        {sent ? sentTitle(amountMinor, to) : over ? 'Not sent' : `Sending ${formatUsd(amountMinor)} to ${recipientShortName(to)}`}
      </p>
      <p className={cn('mt-2 max-w-[34ch] text-[15px]', over ? 'text-alert' : 'text-muted')}>{sent || over ? <FollowLine /> : message}</p>
      <div className="mt-6 flex w-full flex-col gap-2">
        {over && (
          <Button className="w-full" onClick={onAgain}>
            Try again
          </Button>
        )}
        <Button className="w-full" variant={over ? 'ghost' : 'primary'} onClick={() => router.push('/app')}>
          Done
        </Button>
        {sent && (
          <Button variant="ghost" className="w-full" onClick={onDetails}>
            View details
          </Button>
        )}
      </div>
    </Panel>
  )
}

const inputCls =
  'h-12 w-full rounded-[14px] border border-line bg-surface px-4 text-[16px] text-ink placeholder:text-muted/80 outline-none transition-colors focus-visible:border-ink/40 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--brass)]'

export function SendScreen() {
  const { api, config, getSigner } = useApp()
  const session = useSession()
  const router = useRouter()
  const me = session?.user

  const [step, setStep] = useState<'to' | 'amount'>('to')
  const [query, setQuery] = useState('')
  const [rs, setRs] = useState<ResolverState>({ kind: 'idle' })
  const [recipient, setRecipient] = useState<PublicProfile | null>(null)
  const [amountText, setAmountText] = useState('')
  const [amountMinor, setAmountMinor] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<SendProblem | null>(null)
  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState<Transfer | null>(null)
  const [sheet, setSheet] = useState(false)
  const [limit, setLimit] = useState<ApiErrorDetails | null>(null)
  const [followed, setFollowed] = useState<Intent | null>(null)
  /** A payment whose answer was lost: followed in place of the keypad until it settles. */
  const [unsure, setUnsure] = useState<string | null>(null)
  const autoPick = useRef<string | null>(null)
  const attempted = useRef(false)
  const unsureOf = useRef<{ intent: Intent; message: string } | null>(null)

  const balance = useResource(() => api.call('balance'), [api])
  const contacts = useResource(() => api.call('contacts'), [api])

  // ---- live: balance, and the intent we just sent ----
  const followedId = followed?.id
  const onEvent = useCallback(
    (e: ZeccaEvent) => {
      if (e.type === 'balance.updated') balance.setData(e.data)
      if (e.type === 'intent.updated' && e.data.id === followedId) setFollowed(e.data)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [followedId],
  )
  const onPoll = useCallback(() => {
    balance.refresh()
    if (followedId)
      api
        .call('transferGet', { params: { id: followedId } })
        .then(setFollowed)
        .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, followedId])
  useLiveEvents(onEvent, onPoll)

  // ---- the "To" lookup ----
  const resolver = useRef<ReturnType<typeof createResolver> | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const prefilled = useRef(false)
  useEffect(() => {
    const r = createResolver({ resolve: (q, signal) => api.call('resolve', { query: { q }, signal }), selfId: me?.id, onChange: setRs })
    resolver.current = r
    // /app/send?to=<handle>: look it up once, and go straight to the amount when it is a Zecca user.
    if (!prefilled.current) {
      prefilled.current = true
      const to = sendToParam(window.location.search)
      if (to) {
        autoPick.current = lookupQuery(to)
        queryRef.current = to
        setQuery(to)
      }
    }
    r.input(queryRef.current)
    return () => r.dispose()
  }, [api, me?.id])

  const typeTo = (text: string) => {
    setQuery(text)
    resolver.current?.input(text)
  }

  // Picked from the keyboard (Enter on a row or in the field): the amount field takes focus, instead of <body>.
  const amountInput = useRef<HTMLInputElement>(null)
  const focusAmount = useRef(false)
  const pick = useCallback((p: PublicProfile) => {
    try {
      focusAmount.current = !!document.activeElement?.matches(':focus-visible')
    } catch {
      focusAmount.current = false
    }
    setRecipient(p)
    setProblem(null)
    setStep('amount')
  }, [])

  useEffect(() => {
    if (step !== 'amount' || !focusAmount.current) return
    focusAmount.current = false
    amountInput.current?.focus()
  }, [step])

  useEffect(() => {
    if (rs.kind === 'idle' || rs.kind === 'waiting' || autoPick.current === null) return
    if (rs.q === autoPick.current && rs.kind === 'found') pick(rs.profile)
    autoPick.current = null
  }, [rs, pick])

  // ---- amount ----
  const tier = me?.tier ?? 0
  const live = useMemo(
    () => (config && amountMinor ? checkSendAmount({ minor: amountMinor, availableMinor: balance.data?.availableMinor ?? null, tier, limits: config.limits }) : null),
    [config, amountMinor, balance.data, tier],
  )
  // While typing, say a short balance at once; a limit opens its sheet on Continue.
  const shown: SendProblem | null = problem ?? (live?.kind === 'short' ? live : null)

  const create = (to: PublicProfile, minor: number) =>
    api.call('transferCreate', { body: { to: to.id, amountMinor: minor, ...(note.trim() ? { note: note.trim() } : {}) } })

  const takeOver = (e: unknown): boolean => {
    if (!isApiError(e)) return false
    const p = sendProblemOf(e)
    if (p.kind === 'limit') setLimit(p.details)
    else if (p.kind === 'short') setProblem(p)
    else return false
    return true
  }

  async function onContinue() {
    if (!recipient || !config || creating) return
    const p = checkSendAmount({ minor: amountMinor, availableMinor: balance.data?.availableMinor ?? null, tier, limits: config.limits })
    if (p?.kind === 'empty') return setProblem(null)
    if (p?.kind === 'limit') return setLimit(p.details)
    if (p) return setProblem(p)
    setProblem(null)
    setCreating(true)
    try {
      const res = await create(recipient, amountMinor!)
      attempted.current = false
      setFollowed(null)
      setPending(res)
      setSheet(true)
    } catch (e) {
      if (!takeOver(e)) setProblem({ kind: 'message', message: e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.' })
    } finally {
      setCreating(false)
    }
  }

  async function approve(): Promise<ApproveOutcome> {
    if (!pending || !recipient || !amountMinor) throw new Error('Start again.')
    const retry = attempted.current
    attempted.current = true
    unsureOf.current = null
    const intent = await approveTransfer(pending, retry, {
      getIntent: (id) => api.call('transferGet', { params: { id } }),
      create: () => create(recipient, amountMinor),
      submit: async (prepared: PreparedTx) => (await signAndSubmit(api, await getSigner(), prepared)).intent,
      onTransfer: setPending,
      onUnsure: (i, message) => (unsureOf.current = { intent: i, message }),
    })
    setFollowed(intent)
    balance.refresh()
    return {
      title: sentTitle(amountMinor, recipient),
      line: <FollowLine />,
      announce: `Sent, ${spokenUsd(amountMinor)} to ${recipientShortName(recipient)}`,
    }
  }

  /** The sheet's errors: a payment that may still land is followed here, not offered again. */
  const onApproveError = (e: ZeccaApiError): boolean => {
    const u = unsureOf.current
    unsureOf.current = null
    if (!u) return takeOver(e)
    setFollowed(u.intent)
    setUnsure(u.message)
    balance.refresh()
    return true
  }

  const startOver = () => {
    setUnsure(null)
    setFollowed(null)
    setPending(null)
  }

  // ---- render ----
  const filtered = contacts.data ? matchContacts(contacts.data, query, rs.kind === 'found' ? rs.profile.id : undefined) : []

  if (step === 'amount' && recipient) {
    return (
      <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setStep('to')} className="-ml-2 grid size-11 shrink-0 place-items-center rounded-full text-ink hover:bg-ink/5" aria-label="Back">
            <ArrowLeft className="size-5" aria-hidden="true" />
          </button>
          <h1 className="sr-only">Send to {recipient.displayName}</h1>
          <Avatar name={recipient.displayName} business={recipient.isMerchant} size={40} />
          <span className="min-w-0 flex-1" aria-hidden="true">
            <span className="block truncate text-[16px] font-[680] leading-tight">{recipient.displayName}</span>
            <span className="block truncate text-[13.5px] text-muted">@{recipient.handle}</span>
          </span>
          <Button variant="ghost" className="min-h-11 shrink-0 px-3 text-[14px]" onClick={() => setStep('to')}>
            Change
          </Button>
        </div>
        <ConfigProblem />
        {unsure && amountMinor ? (
          <FollowCtx.Provider value={{ intent: followed, to: recipient }}>
            <StillSending
              amountMinor={amountMinor}
              message={unsure}
              onAgain={startOver}
              onDetails={() => followed && router.push(`/app/activity/${encodeURIComponent(followed.id)}`)}
            />
          </FollowCtx.Provider>
        ) : (
          <Panel className="flex flex-col items-center gap-2">
            <AmountKeypad
              inputRef={amountInput}
              value={amountText}
              onChange={(text, minor) => {
                setAmountText(text)
                setAmountMinor(minor)
                setProblem(null)
              }}
              error={shown && shown.kind !== 'empty' && shown.kind !== 'limit' ? shown.message : undefined}
              hint={balance.data ? `Available ${formatUsd(balance.data.availableMinor)}` : undefined}
            />
            {shown?.kind === 'short' && (config?.features.ramp || config?.demoMode) && (
              <Link href="/app/topup" className="inline-flex min-h-11 items-center rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[650]">
                Top up
              </Link>
            )}
            <label htmlFor="send-note" className="sr-only">
              Note (optional)
            </label>
            <input id="send-note" className={cn(inputCls, 'mt-1')} value={note} maxLength={140} onChange={(e) => setNote(e.target.value)} placeholder="Add a note (optional)" autoComplete="off" />
            {/* Busy is aria-disabled, not disabled: the button keeps focus, so the approve sheet gives it back on close. */}
            <Button
              className={cn('mt-1 w-full', creating && 'opacity-40')}
              onClick={onContinue}
              disabled={!amountMinor || !config}
              aria-disabled={creating || undefined}
              aria-busy={creating || undefined}
            >
              Continue
            </Button>
          </Panel>
        )}

        <FollowCtx.Provider value={{ intent: followed, to: recipient }}>
          <ApproveSheet
            open={sheet && !!pending}
            onClose={() => setSheet(false)}
            title={`Send ${formatUsd(amountMinor ?? 0)} to ${recipient.displayName}`}
            subline={`@${recipient.handle}`}
            feeMinor={pending?.intent.feeMinor ?? 0}
            details={note.trim() ? <p className="rounded-[14px] bg-paper px-4 py-3 text-[15px] text-ink">“{note.trim()}”</p> : undefined}
            run={approve}
            onDone={() => router.push('/app')}
            onViewDetails={() => pending && router.push(`/app/activity/${encodeURIComponent(pending.intent.id)}`)}
            onError={onApproveError}
          />
        </FollowCtx.Provider>
        {config && (
          <LimitSheet open={!!limit} onClose={() => setLimit(null)} limits={config.limits} details={limit ?? undefined} verifyHref={config.features.identity ? '/app/identity' : undefined} />
        )}
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4">
      <h1 className="px-1 text-[22px] font-[740] tracking-[-0.02em]">Send</h1>
      <Panel>
        <label htmlFor="send-to" className="text-[14px] font-[650] text-ink">
          To
        </label>
        <input
          id="send-to"
          className={cn(inputCls, 'mt-1.5')}
          value={query}
          onChange={(e) => typeTo(e.target.value)}
          placeholder="@handle, phone or email"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          aria-describedby="send-to-status"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && rs.kind === 'found') pick(rs.profile)
          }}
        />
        <div id="send-to-status" className="mt-2" aria-live="polite">
          <LookupResult state={rs} onPick={pick} onRetry={() => resolver.current?.input(query)} />
        </div>
      </Panel>

      <Panel title="Recent">
        {contacts.error && !contacts.data ? (
          <div className="flex flex-col items-start gap-3 py-2" role="alert">
            <p className="text-[15px]">{contacts.error}</p>
            <Button variant="secondary" className="min-h-11" onClick={contacts.reload}>
              <RotateCw className="size-4" aria-hidden="true" /> Retry
            </Button>
          </div>
        ) : !contacts.data ? (
          <div aria-busy="true" aria-label="Loading contacts">
            <RecipientRowSkeleton />
            <RecipientRowSkeleton />
          </div>
        ) : contacts.data.length === 0 ? (
          <p className="py-2 text-[15px] text-muted">People you pay or get paid by show up here.</p>
        ) : filtered.length === 0 ? (
          <p className="py-2 text-[15px] text-muted">No recent contact matches that.</p>
        ) : (
          <ul className="-mx-2 flex flex-col">
            {filtered.map((p) => (
              <li key={p.id}>
                <RecipientRow profile={p} onPick={pick} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}

function LookupResult({ state, onPick, onRetry }: { state: ResolverState; onPick: (p: PublicProfile) => void; onRetry: () => void }) {
  switch (state.kind) {
    case 'idle':
      return null
    case 'waiting':
      return (
        <div aria-busy="true" aria-label="Looking up">
          <RecipientRowSkeleton />
        </div>
      )
    case 'found':
      return (
        <div className="-mx-2">
          <RecipientRow profile={state.profile} onPick={onPick} />
        </div>
      )
    case 'self':
      return <Line>That's you. Pick someone else.</Line>
    case 'external':
      return <Line>That's an account outside Zecca. Sending outside Zecca isn't supported yet.</Line>
    case 'unknown':
      return <Line>No one on Zecca matches that. Check it, or ask them for their @handle.</Line>
    case 'error':
      return (
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <Line tone="alert">
            <span role="alert">{state.message}</span>
          </Line>
          <Button variant="secondary" className="min-h-11" onClick={onRetry}>
            <RotateCw className="size-4" aria-hidden="true" /> Retry
          </Button>
        </div>
      )
  }
}

function Line({ children, tone }: { children: React.ReactNode; tone?: 'alert' }) {
  return <p className={cn('py-2 text-[15px]', tone === 'alert' ? 'text-alert' : 'text-muted')}>{children}</p>
}
