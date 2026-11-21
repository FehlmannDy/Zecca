'use client'
// The pay page (UI.md §5.5). Opens from an NFC tap or a QR scan, often in a fresh browser, and shows the request at
// once, signed out too. Signed in: "Pay $4.50 to Caffè Bruno" / "Approve" -> the arches -> "Paid" with a tick and the time.
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Check } from 'lucide-react'
import { formatUsd, type PaymentRequest } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { isApiError } from '@/lib/api'
import { activityWhen } from '@/lib/activity'
import { approveStatus, archesFill } from '@/lib/arches'
import { safeNextPath } from '@/lib/next-path'
import { useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { signAndSubmit } from '@/lib/wallet/sign-and-submit'
import { Amount } from '@/components/zecca/amount'
import { ArchesProgress } from '@/components/zecca/arches'
import { Avatar, Button, Skeleton } from '@/components/zecca/bits'
import { GlassBackdrop } from '@/components/zecca/glass'
import { LimitSheet } from '@/components/zecca/limit-sheet'
import { useHydrated } from '@/components/zecca/user-shell'
import { Logo } from '@/components/zecca/wordmark'
import { paidAnnouncement, payErrorView, payHrefs, payState, payTitle, type PayFailure } from './pay-model'
import { mergeRequest } from './till-model'
import { useInterval, useRequestStream } from './use-request-stream'

const EXPECTED_MS = 10_000
const SLOW = 'Taking longer than usual. You can leave this page: the payment shows in your activity.'
const linkCls = 'inline-flex min-h-12 w-full items-center justify-center rounded-[14px] px-5 text-[15px] font-[680]'

export function PayScreen({ id }: { id: string }) {
  const { api, config, getSigner } = useApp()
  const session = useSession()
  const hydrated = useHydrated()
  const [missing, setMissing] = useState(false)
  const load = useResource(
    () =>
      api.call('paymentRequestGet', { params: { id } }).catch((e: unknown) => {
        setMissing(isApiError(e) && e.code === 'not_found')
        throw e
      }),
    [api, id],
  )
  const [request, setRequest] = useState<PaymentRequest | null>(null)
  const [paying, setPaying] = useState(false)
  const [paidByMe, setPaidByMe] = useState(false)
  const [failure, setFailure] = useState<PayFailure | null>(null)
  const [limitOpen, setLimitOpen] = useState(false)
  const [startedAt, setStartedAt] = useState(0)
  const [status, setStatus] = useState('')
  const [returnTo, setReturnTo] = useState<string | null>(null)
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('return')
    setReturnTo(r ? safeNextPath(r) : null)
  }, [])

  const onRequest = useCallback((r: PaymentRequest) => setRequest((c) => mergeRequest(c, r)), [])
  useEffect(() => {
    if (load.data) onRequest(load.data)
  }, [load.data, onRequest])
  const poll = useCallback(() => {
    api
      .call('paymentRequestGet', { params: { id } })
      .then(onRequest)
      .catch(() => {})
  }, [api, id, onRequest])
  const live = request && (request.status === 'created' || request.status === 'opened')
  useRequestStream(live ? id : null, onRequest, poll)
  // Our deposit is on the ledger; the stream says "paid" once the pool has verified it. Poll as a safety net.
  useInterval(poll, 2000, paidByMe && request?.status !== 'paid')
  useEffect(() => {
    if (!paidByMe || request?.status === 'paid') return
    const t = setTimeout(() => setSlow(true), 45_000)
    return () => clearTimeout(t)
  }, [paidByMe, request?.status])

  const signedIn = hydrated && !!session?.user
  const state = payState({ request, loadError: load.error, missing, signedIn, userId: session?.user?.id, paying, paidByMe, failure })

  useInterval(() => setStatus(approveStatus(archesFill(performance.now() - startedAt, EXPECTED_MS), false)), 250, state.kind === 'working')
  // Approve unmounts with the click: put focus on what replaced it, the title while working, then "Paid".
  const focusTarget = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (state.kind === 'working' || state.kind === 'paid') focusTarget.current?.focus()
  }, [state.kind])

  async function approve() {
    if (!request) return
    setFailure(null)
    setPaying(true)
    setStartedAt(performance.now())
    setStatus(approveStatus(0, false))
    try {
      const { prepared } = await api.call('paymentRequestPay', { params: { id } })
      const signer = await getSigner()
      const res = await signAndSubmit(api, signer, prepared)
      setPaidByMe(true)
      if (res.intent && (res.intent.status === 'received' || res.intent.status === 'paid_out')) poll()
    } catch (e) {
      const f = payErrorView(e)
      setPaying(false)
      setFailure(f)
      if (f.kind === 'limit') setLimitOpen(true)
      if (f.kind === 'expired' || f.kind === 'already_paid') poll()
    }
  }

  const hrefs = payHrefs(id, returnTo)
  const doneHref = returnTo ?? '/app'
  const doneLabel = returnTo ? `Back to ${request?.merchantName ?? 'the shop'}` : 'Done'
  // One live region, mounted from the start, so the progress and the result are announced (UI.md §6).
  const announcement = state.kind === 'working' ? (slow ? SLOW : status) : state.kind === 'paid' && request ? paidAnnouncement(request) : ''

  return (
    <div className="relative min-h-svh">
      <GlassBackdrop />
      <div className="mx-auto flex min-h-svh max-w-[440px] flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))] lg:max-w-[520px] lg:justify-center">
        <header className="self-start">
          <Link href="/app" aria-label="Zecca" className="block rounded-[10px]">
            <Logo />
          </Link>
        </header>
        <main className="flex flex-1 flex-col items-center justify-center text-center lg:my-10 lg:flex-none lg:rounded-[28px] lg:border lg:border-[color-mix(in_srgb,var(--ink)_8%,transparent)] lg:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] lg:px-10 lg:py-12 lg:shadow-[var(--shadow-float)] lg:backdrop-blur-md">
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>
          {state.kind === 'loading' ? (
            <div className="flex flex-col items-center gap-4" aria-busy="true" aria-label="Loading the request">
              <Skeleton className="size-16 rounded-[16px]" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-14 w-48" />
              <Skeleton className="mt-6 h-12 w-64 rounded-[14px]" />
            </div>
          ) : state.kind === 'error' ? (
            <div className="flex flex-col items-center gap-5">
              <p className="max-w-[30ch] text-[17px] font-[600]" role="alert">
                {state.message}
              </p>
              <Button variant="secondary" onClick={load.reload}>
                Try again
              </Button>
            </div>
          ) : state.kind === 'not_found' ? (
            <div className="flex w-full flex-col items-center">
              <Notice title="This payment link is not valid." line="Check the link, or ask the merchant for a new one." href={doneHref} label={returnTo ? 'Back to the shop' : 'Go to home'} />
            </div>
          ) : state.kind === 'paid' && request ? (
            <PaidView request={request} at={state.at} doneHref={doneHref} doneLabel={doneLabel} headingRef={focusTarget} />
          ) : (
            request && (
              <>
                <Avatar name={request.merchantName} size={64} business />
                <h1 className="mt-4 text-[20px] font-[700]">{request.merchantName}</h1>
                <Amount minor={request.amountMinor} size="hero" className="mt-3" />
                {request.reference && <p className="mt-2 text-[15px] text-muted">{request.reference}</p>}

                <div className="mt-9 flex w-full flex-col items-center">
                  {state.kind === 'signin' && (
                    <>
                      <Link href={hrefs.signIn} className={`${linkCls} bg-ink text-paper hover:opacity-90`}>
                        Sign in to pay
                      </Link>
                      <p className="mt-3 text-[13.5px] text-muted">New to Zecca? Signing up takes a minute and comes with demo credit.</p>
                    </>
                  )}
                  {state.kind === 'ready' && (
                    <>
                      <p className="text-[19px] font-[720] tracking-[-0.02em]">{payTitle(request)}</p>
                      <p className="mt-1 text-[14px] text-muted">No fee for you · from @{session?.user?.handle}</p>
                      <Button className="mt-5 w-full" onClick={approve} autoFocus>
                        Approve
                      </Button>
                    </>
                  )}
                  {state.kind === 'working' && (
                    <>
                      <p ref={(el) => void (focusTarget.current = el)} tabIndex={-1} className="text-[17px] font-[680] outline-none">
                        {payTitle(request)}
                      </p>
                      <ArchesProgress state="running" expectedMs={EXPECTED_MS} className="mt-7 h-11" label={status || 'Payment progress'} />
                      <p className="mt-4 min-h-6 text-[15px] text-muted">{slow ? SLOW : status}</p>
                    </>
                  )}
                  {state.kind === 'own' && <p className="max-w-[32ch] text-[15px] text-muted">This is your own request. Show the code to your customer to get paid.</p>}
                  {state.kind === 'already_paid' && (
                    <Notice title="This request has already been paid." line="Nothing more to do here." href={doneHref} label={doneLabel} />
                  )}
                  {state.kind === 'expired' && <Notice title="This request has expired." line="Ask the merchant for a new one." href={doneHref} label={doneLabel} />}
                  {state.kind === 'cancelled' && <Notice title="This request was cancelled." line="Ask the merchant for a new one." href={doneHref} label={doneLabel} />}
                  {state.kind === 'short' && (
                    <>
                      <p className="text-[17px] font-[680]" role="alert">
                        {state.shortMinor > 0 ? `You need ${formatUsd(state.shortMinor)} more.` : state.message}
                      </p>
                      <Link href={hrefs.topUp} className={`${linkCls} mt-5 bg-ink text-paper hover:opacity-90`}>
                        Top up
                      </Link>
                      <Button variant="ghost" className="mt-2 w-full" onClick={approve}>
                        Try again
                      </Button>
                    </>
                  )}
                  {state.kind === 'limit' && (
                    <>
                      <p className="max-w-[32ch] text-[16px] font-[650]" role="alert">
                        {state.message}
                      </p>
                      <Button variant="secondary" className="mt-5 w-full" onClick={() => setLimitOpen(true)}>
                        See your limits
                      </Button>
                    </>
                  )}
                  {state.kind === 'message' && (
                    <>
                      <p className="max-w-[32ch] text-[15px] text-alert" role="alert">
                        {state.message}
                      </p>
                      <Button className="mt-5 w-full" onClick={approve}>
                        Try again
                      </Button>
                    </>
                  )}
                </div>
              </>
            )
          )}
        </main>
      </div>
      {config && <LimitSheet open={limitOpen} onClose={() => setLimitOpen(false)} limits={config.limits} details={failure?.kind === 'limit' ? failure.details : undefined} message={failure?.kind === 'limit' ? failure.message : undefined} verifyHref={config.features.identity ? '/app/identity' : undefined} />}
    </div>
  )
}

function Notice({ title, line, href, label }: { title: string; line: string; href: string; label: string }) {
  return (
    <>
      <p className="text-[17px] font-[680]" role="status">
        {title}
      </p>
      <p className="mt-1.5 text-[15px] text-muted">{line}</p>
      <Link href={href} className={`${linkCls} mt-6 border border-line bg-surface text-ink hover:border-ink/30`}>
        {label}
      </Link>
    </>
  )
}

function PaidView({
  request,
  at,
  doneHref,
  doneLabel,
  headingRef,
}: {
  request: PaymentRequest
  at?: string
  doneHref: string
  doneLabel: string
  headingRef: React.RefObject<HTMLElement | null>
}) {
  return (
    <div className="flex flex-col items-center">
      <span className="grid size-24 place-items-center rounded-full bg-[var(--in)] text-[var(--paper)] motion-safe:animate-[z-fade-in_240ms_ease-out]" aria-hidden="true">
        <Check className="size-12" strokeWidth={2.6} />
      </span>
      <h1 ref={(el) => void (headingRef.current = el)} tabIndex={-1} className="mt-6 text-[34px] font-[760] tracking-[-0.035em] outline-none">
        Paid
      </h1>
      <p className="mt-2 text-[17px]">
        <span className="tabular font-[700]">{formatUsd(request.amountMinor)}</span> to {request.merchantName}
      </p>
      {request.reference && <p className="mt-1 text-[15px] text-muted">{request.reference}</p>}
      <p className="mt-1 text-[15px] text-muted">{activityWhen(at ?? new Date().toISOString())}</p>
      <ArchesProgress state="done" className="mt-7 h-8" label="Payment complete" />
      <Link href={doneHref} className={`${linkCls} mt-8 bg-ink text-paper hover:opacity-90`}>
        {doneLabel}
      </Link>
    </div>
  )
}
