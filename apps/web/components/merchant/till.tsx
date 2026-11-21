'use client'
// The till (UI.md §5.8): keypad, large amount, optional reference, "Charge". Then a full screen with the amount and
// the QR code (and the NFC prompt on Android), the status from the request's public stream, and full-screen "Paid".
import { useCallback, useEffect, useRef, useState } from 'react'
import { Nfc, X } from 'lucide-react'
import { formatUsd, spokenUsd, type PaymentRequest } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { isApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Amount } from '@/components/zecca/amount'
import { AmountKeypad } from '@/components/zecca/amount-keypad'
import { ArchesProgress } from '@/components/zecca/arches'
import { Button } from '@/components/zecca/bits'
import { QrCode } from './qr-code'
import { expiresIn, isAndroid, mergeRequest, nfcAppUrl, tillPhase, tillStatusLine } from './till-model'
import { copyText } from './copy-text'
import { useInterval, useRequestStream } from './use-request-stream'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

const inputCls =
  'h-12 w-full rounded-[14px] border border-line bg-surface px-4 text-[16px] text-ink placeholder:text-muted/80 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--brass)]'

export function Till({ className }: { className?: string }) {
  const { api, config } = useApp()
  const [text, setText] = useState('')
  const [minor, setMinor] = useState<number | null>(null)
  const [reference, setReference] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [request, setRequest] = useState<PaymentRequest | null>(null)
  const root = useRef<HTMLDivElement>(null)
  // Stable, so ChargeScreen's poll (and the effects that depend on it) do not change on every render.
  const onRequest = useCallback((r: PaymentRequest) => setRequest((c) => mergeRequest(c, r)), [])

  const cap = config?.limits.txCapMinor
  const tooBig = minor !== null && cap !== undefined && minor > cap
  const canCharge = minor !== null && minor > 0 && !tooBig && !creating

  async function charge() {
    if (!canCharge || minor === null) return
    setCreating(true)
    setError('')
    try {
      const r = await api.call('paymentRequestCreate', { body: { amountMinor: minor, ...(reference.trim() ? { reference: reference.trim() } : {}) } })
      setRequest(r)
    } catch (e) {
      setError(isApiError(e) || e instanceof Error ? e.message : "We couldn't create the charge. Try again.")
    } finally {
      setCreating(false)
    }
  }

  /** Back to the keypad; from the keyboard, focus goes back to the amount (a tap would only pop the phone's keyboard). */
  const newCharge = useCallback((fromKeyboard: boolean) => {
    setRequest(null)
    setText('')
    setMinor(null)
    setReference('')
    setError('')
    if (fromKeyboard) requestAnimationFrame(() => root.current?.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.focus())
  }, [])

  const phase = tillPhase(request, creating)
  return (
    <div ref={root} className={cn('mx-auto flex w-full max-w-[420px] flex-col items-center', className)}>
      <AmountKeypad
        // On a short phone (360x740) the keypad rows shrink so "Charge" clears the dock.
        className="[@media(max-height:760px)]:[&_[role=group]>button]:h-12"
        value={text}
        onChange={(v, m) => {
          setText(v)
          setMinor(m)
          setError('')
        }}
        label="Charge"
        error={tooBig && cap !== undefined ? `The most per charge is ${formatUsd(cap)}.` : error || undefined}
      />
      <label className="mt-4 w-full max-w-[320px]">
        <span className="sr-only">Reference (optional)</span>
        <input className={inputCls} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} placeholder="Reference (optional)" autoComplete="off" enterKeyHint="go" />
      </label>
      <Button className="mt-4 w-full max-w-[320px]" disabled={!canCharge} onClick={charge} aria-busy={creating}>
        {creating ? 'Charging…' : minor ? `Charge ${formatUsd(minor)}` : 'Charge'}
      </Button>
      {request && phase !== 'entry' && phase !== 'creating' && <ChargeScreen request={request} onRequest={onRequest} onNew={newCharge} />}
    </div>
  )
}

function ChargeScreen({ request, onRequest, onNew }: { request: PaymentRequest; onRequest: (r: PaymentRequest) => void; onNew: (fromKeyboard: boolean) => void }) {
  const { api } = useApp()
  const phase = tillPhase(request, false)
  const open = phase === 'waiting' || phase === 'paying'
  const dialog = useRef<HTMLDivElement>(null)
  const paid = phase === 'paid'

  // A modal over the till: focus moves into it (its "New charge" button autofocuses once settled) and Tab stays inside.
  useEffect(() => {
    const el = dialog.current
    if (el && !el.contains(document.activeElement)) el.focus()
  }, [paid, open])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = dialog.current
      if (e.key !== 'Tab' || !el) return
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null)
      if (items.length === 0) return e.preventDefault()
      const [a, b] = [items[0], items[items.length - 1]]
      const at = document.activeElement
      if (!el.contains(at) || (e.shiftKey ? at === a || at === el : at === b)) {
        e.preventDefault()
        ;(e.shiftKey ? b : a).focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
  const [android, setAndroid] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [cancelError, setCancelError] = useState('')
  useEffect(() => setAndroid(isAndroid(navigator.userAgent)), [])

  const poll = useCallback(() => {
    api
      .call('paymentRequestGet', { params: { id: request.id } })
      .then(onRequest)
      .catch(() => {})
  }, [api, request.id, onRequest])
  const stream = useRequestStream(open ? request.id : null, onRequest, poll)
  // The countdown; when it runs out, ask the API (which expires the request on read).
  useInterval(() => setNow(Date.now()), 1000, open)
  const due = open && Date.parse(request.expiresAt) <= now
  useEffect(() => {
    if (due) poll()
  }, [due, poll])
  // While the stream is down it already polls every 2 s.
  useInterval(poll, 2000, due && stream !== 'polling')

  async function cancel() {
    setCancelError('')
    try {
      onRequest(await api.call('paymentRequestCancel', { params: { id: request.id } }))
    } catch (e) {
      setCancelError(isApiError(e) ? e.message : "We couldn't cancel it. Try again.")
      poll()
    }
  }

  // Escape returns to the keypad only once nothing is pending.
  useEffect(() => {
    if (open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onNew(true)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onNew])

  if (phase === 'paid') {
    return (
      <div
        ref={dialog}
        tabIndex={-1}
        className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[var(--in)] px-6 text-center outline-none motion-safe:animate-[z-fade-in_200ms_ease-out]"
        role="dialog"
        aria-modal="true"
        aria-label="Paid"
      >
        {/* Text in --paper on --in reads in both themes (white would not on the dark theme's light green). */}
        <div className="flex flex-col items-center text-[var(--paper)]" style={{ ['--in' as string]: 'var(--paper)', ['--line' as string]: 'color-mix(in srgb, var(--paper) 30%, transparent)' }}>
          <ArchesProgress state="done" className="h-14" label="Payment complete" />
          <p className="mt-8 text-[56px] font-[760] leading-none tracking-[-0.04em]">Paid</p>
          <Amount minor={request.amountMinor} size="hero" className="mt-4 !text-[var(--paper)]" />
          {request.reference && <p className="mt-3 text-[16px] opacity-85">{request.reference}</p>}
          <p className="mt-2 text-[15px] opacity-85">
            {new Date(request.paidAt ?? Date.now()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </p>
          <button
            type="button"
            onClick={(e) => onNew(e.detail === 0)}
            autoFocus
            className="mt-10 inline-flex min-h-12 min-w-[220px] items-center justify-center rounded-[14px] bg-[var(--paper)] px-6 text-[15px] font-[700] text-[var(--ink)] hover:opacity-90"
          >
            New charge
          </button>
        </div>
        <p className="sr-only" aria-live="assertive">
          Paid, {spokenUsd(request.amountMinor)}
        </p>
      </div>
    )
  }

  return (
    <div
      ref={dialog}
      tabIndex={-1}
      className="fixed inset-0 z-50 overflow-y-auto bg-paper outline-none motion-safe:animate-[z-fade-in_200ms_ease-out]"
      role="dialog"
      aria-modal="true"
      aria-label={`Charge ${formatUsd(request.amountMinor)}`}
    >
      <div className="mx-auto flex min-h-full w-full max-w-[440px] flex-col items-center px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(16px,env(safe-area-inset-top))] text-center">
        <div className="flex w-full justify-end">
          {open ? (
            <button type="button" onClick={cancel} className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[14px] font-[650] text-muted hover:bg-ink/5 hover:text-ink">
              <X className="size-4" aria-hidden="true" />
              Cancel charge
            </button>
          ) : (
            <span className="h-11" />
          )}
        </div>
        <Amount minor={request.amountMinor} size="hero" className="mt-2" />
        {request.reference && <p className="mt-2 text-[15px] text-muted">{request.reference}</p>}

        {open ? (
          <>
            <QrCode value={request.url} label={`Payment code for ${formatUsd(request.amountMinor)}`} className="mt-6 w-full max-w-[300px] border border-line" />
            <CopyLink url={request.url} />
            {android && (
              <div className="mt-5 w-full max-w-[300px]">
                <p className="text-[15px] font-[650]">Hold the customer&apos;s phone to the back of this one</p>
                <a
                  href={nfcAppUrl(request.url)}
                  className="mt-3 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[14px] border border-line bg-surface px-5 text-[15px] font-[680] text-ink hover:border-ink/30"
                >
                  <Nfc className="size-5" aria-hidden="true" />
                  Use NFC
                </a>
              </div>
            )}
            <p className="mt-6 flex items-center gap-2 text-[16px] font-[650]" aria-live="polite">
              <span className={cn('size-2.5 rounded-full', phase === 'paying' ? 'bg-brass motion-safe:animate-pulse' : 'bg-muted')} aria-hidden="true" />
              {tillStatusLine(phase)}
            </p>
            <p className="mt-1.5 text-[13.5px] text-muted">
              Expires in <span className="tabular">{expiresIn(request.expiresAt, now)}</span>
              {stream === 'polling' ? ' · Reconnecting' : ''}
            </p>
            {cancelError && (
              <p className="mt-3 text-[14px] text-alert" role="alert">
                {cancelError}
              </p>
            )}
          </>
        ) : (
          <div className="mt-10 flex flex-col items-center">
            <p className="text-[17px] font-[650]" role="status">
              {tillStatusLine(phase)}
            </p>
            {phase === 'expired' && <p className="mt-1.5 text-[15px] text-muted">The customer did not pay in time. Start a new charge.</p>}
            <Button className="mt-8 min-w-[220px]" onClick={(e) => onNew(e.detail === 0)} autoFocus>
              New charge
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** "Copy link" under the QR: the pay link can always be pasted into NFC PayLink (or sent) by hand. */
function CopyLink({ url }: { url: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle')
  return (
    <div className="mt-3 flex w-full max-w-[300px] flex-col items-center gap-2">
      <button
        type="button"
        onClick={async () => {
          const r = await copyText(url)
          setState(r)
          if (r === 'copied') setTimeout(() => setState('idle'), 2000)
        }}
        className="inline-flex min-h-11 items-center justify-center rounded-[14px] px-4 text-[14.5px] font-[650] text-muted underline decoration-line underline-offset-4 hover:text-ink"
      >
        {state === 'copied' ? 'Copied.' : 'Copy link'}
      </button>
      {state === 'manual' && (
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} autoFocus aria-label="Payment link" className="w-full rounded-[14px] border border-line bg-surface px-3 py-2 text-[13px]" />
      )}
    </div>
  )
}
