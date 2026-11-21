'use client'
// Top up (UI.md §5.7): "Add money", amount chips, "Continue" opens MoonPay's widget as an overlay (session and signature
// from our API). After the purchase the screen follows the credit live. In demo mode, "Add demo credit" (POST /v1/dev/credit)
// goes through the same path without the widget. MoonPay is hidden when features.ramp is off.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatUsd, type ZeccaEvent } from '@zecca/contracts'
import { Amount } from '@/components/zecca/amount'
import { ArchesProgress, type ArchesState } from '@/components/zecca/arches'
import { Button, EmptyState, Skeleton } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { LimitSheet } from '@/components/zecca/limit-sheet'
import { isApiError, type ApiErrorDetails } from '@/lib/api'
import { useApp } from '@/lib/app'
import { cn } from '@/lib/cn'
import { useLiveEvents, useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { loadMoonPaySdk, type MoonPayWidget } from './moonpay-sdk'
import { TOPUP_CHIPS, chipsFor, initialTopup, nextAfterTopup, sdkEnvironment, topupReducer } from './topup'

const REGION = "Top-up isn't available in your country yet."
const SANDBOX_NOTE = 'Sandbox purchase. No real money moved.'
const whole = (minor: number) => (minor % 100 === 0 ? `$${minor / 100}` : formatUsd(minor))
/** How long "Added $X." stays before the screen goes back to ?next=. */
const BACK_AFTER_MS = 1500

export function TopupScreen() {
  const { api, config } = useApp()
  const user = useSession()?.user
  const balance = useResource(() => api.call('balance'), [api])
  const [chip, setChip] = useState<number>(TOPUP_CHIPS[1])
  const [state, dispatch] = useReducer(topupReducer, initialTopup)
  const [busy, setBusy] = useState<'widget' | 'demo' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState<ApiErrorDetails | null>(null)
  const [externalTab, setExternalTab] = useState(false)
  const widget = useRef<MoonPayWidget | null>(null)
  /** Recent events, replayed after a demo credit starts: its events can arrive before the POST answers. */
  const recent = useRef<ZeccaEvent[]>([])
  const phase = useRef(state)
  phase.current = state
  /** Activity rows already there when the purchase started: polling (no live stream) only looks at newer ones. */
  const before = useRef<Set<string> | null>(null)
  const router = useRouter()
  /** ?next= (e.g. the pay page): where to go once the money is in. Read after mount (no Suspense needed). */
  const [next, setNext] = useState<string | null>(null)
  useEffect(() => setNext(nextAfterTopup(window.location.search)), [])
  useEffect(() => {
    if (state.phase !== 'done' || !next) return
    const t = setTimeout(() => router.replace(next), BACK_AFTER_MS)
    return () => clearTimeout(t)
  }, [state.phase, next, router])

  const onEvent = useCallback(
    (e: ZeccaEvent) => {
      if (e.type === 'balance.updated') balance.setData(e.data)
      recent.current = [...recent.current.slice(-19), e]
      dispatch({ type: 'event', event: e })
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const onPoll = useCallback(() => {
    balance.refresh()
    const s = phase.current
    if ((s.phase !== 'waiting' && s.phase !== 'arriving') || (!s.intentId && !before.current)) return
    api
      .call('activity', { query: { limit: 20 } })
      .then((p) => {
        const seen = before.current
        dispatch({ type: 'activity', items: s.intentId || !seen ? p.items : p.items.filter((x) => !seen.has(x.id)) })
      })
      .catch(() => {}) // the next poll tries again
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useLiveEvents(onEvent, onPoll)

  const failWith = (e: unknown) => {
    if (isApiError(e) && e.code === 'limit_reached') setLimit(e.details ?? {})
    else setError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
  }

  /** The purchase started (MoonPay calls back on created and completed: only the first counts). */
  function purchased(amountMinor: number) {
    if (phase.current.phase === 'choose') {
      before.current = null
      api
        .call('activity', { query: { limit: 20 } })
        .then((p) => (before.current = new Set(p.items.map((x) => x.id))))
        .catch(() => {}) // without it, only the live stream moves the screen on
    }
    dispatch({ type: 'purchased', amountMinor })
  }

  async function openMoonPay() {
    setBusy('widget')
    setError(null)
    setExternalTab(false)
    const amountMinor = chip
    try {
      const s = await api.call('rampSession', { body: { direction: 'buy', fiatAmount: amountMinor / 100, fiatCurrency: 'usd' } })
      let sdk
      try {
        if (!s.params) throw new Error('no SDK params')
        sdk = await loadMoonPaySdk()
      } catch {
        // The SDK could not load (blocked script): the signed URL works on its own in a new tab.
        window.open(s.widgetUrl, '_blank', 'noopener')
        setExternalTab(true)
        purchased(amountMinor)
        return
      }
      const onPurchase = async () => purchased(amountMinor)
      const w = sdk.init({
        flow: 'buy',
        environment: sdkEnvironment(s.widgetUrl),
        variant: 'overlay',
        params: s.params!,
        handlers: {
          onTransactionCreated: onPurchase,
          onTransactionCompleted: onPurchase,
          onUnsupportedRegion: async () => {
            try {
              w.close?.()
            } catch {
              /* already closed */
            }
            setError(REGION)
          },
          onClose: async () => {
            widget.current = null
          },
        },
      })
      const { signature } = await api.call('rampSign', { body: { url: w.generateUrlForSigning() } })
      w.updateSignature(signature)
      widget.current = w
      w.show()
    } catch (e) {
      failWith(e)
    } finally {
      setBusy(null)
    }
  }

  async function addDemoCredit() {
    setBusy('demo')
    setError(null)
    try {
      const intent = await api.call('devCredit', { body: { amountMinor: chip } })
      dispatch({ type: 'demoCredit', intent })
      for (const e of recent.current) dispatch({ type: 'event', event: e })
    } catch (e) {
      failWith(e)
    } finally {
      setBusy(null)
    }
  }

  if (!config || !user) return <TopupSkeleton />
  const rampOn = config.features.ramp
  const sandbox = config.rampSandboxScale !== 1
  if (!rampOn && !config.demoMode) {
    return (
      <Shell>
        <Panel>
          <EmptyState title="Top up is not available yet." action={<HomeLink />} />
        </Panel>
      </Shell>
    )
  }

  const b = balance.data
  const room = chipsFor({ tier: user.tier, availableMinor: b?.availableMinor ?? null, pendingMinor: b?.pendingMinor ?? null, limits: config.limits })
  const chipAllowed = room.chips.find((c) => c.minor === chip)?.allowed ?? true
  const noRoom = room.chips.every((c) => !c.allowed)

  if (state.phase !== 'choose') {
    const amount = state.amountMinor ?? state.expectedMinor ?? chip
    const arches: ArchesState = state.phase === 'done' ? 'done' : state.phase === 'failed' ? 'failed' : 'running'
    const title =
      state.phase === 'done'
        ? `Added ${formatUsd(amount)}.`
        : state.phase === 'failed'
          ? "This top-up didn't go through."
          : state.demo
            ? `Adding ${formatUsd(amount)} demo credit.`
            : externalTab
              ? 'Finish your purchase in the MoonPay tab.'
              : 'Payment received.'
    const body =
      state.phase === 'done'
        ? "You'll see it in your balance."
        : state.phase === 'failed'
          ? state.message
          : state.demo
            ? 'It shows in your balance in a few seconds.'
            : 'Your balance updates when the transfer lands, usually under a minute.'
    return (
      <Shell>
        <Panel className="flex flex-col items-center px-6 py-8 text-center">
          <ArchesProgress state={arches} expectedMs={state.demo ? 8_000 : 45_000} label="Top-up progress" />
          <div aria-live="polite" className="mt-6">
            <p className="text-[20px] font-[740] tracking-[-0.02em]">{title}</p>
            {body && (
              <p className={cn('mx-auto mt-2 max-w-[34ch] text-[15px]', state.phase === 'failed' ? 'text-alert' : 'text-muted')} role={state.phase === 'failed' ? 'alert' : undefined}>
                {body}
              </p>
            )}
          </div>
          {(state.phase === 'done' || state.phase === 'failed') && (
            <div className="mt-7 flex w-full flex-col gap-2 sm:flex-row">
              <Link href={next ?? '/app'} className="inline-flex min-h-12 flex-1 items-center justify-center rounded-[14px] bg-ink px-5 text-[15px] font-[680] text-paper hover:opacity-90">
                {next && state.phase === 'done' ? 'Continue' : 'Done'}
              </Link>
              <Button variant="secondary" className="flex-1" onClick={() => dispatch({ type: 'reset' })}>
                {state.phase === 'failed' ? 'Try again' : 'Add more'}
              </Button>
            </div>
          )}
          {!state.demo && sandbox && <p className="mt-6 text-[12.5px] text-muted">{SANDBOX_NOTE}</p>}
        </Panel>
      </Shell>
    )
  }

  return (
    <Shell>
      <Panel>
        <span id="topup-amount" className="label-caps text-muted">
          Amount
        </span>
        <div className="mt-2" aria-live="polite">
          <Amount minor={chip} size="xl" />
        </div>
        <div role="radiogroup" aria-labelledby="topup-amount" className="mt-5 flex flex-wrap gap-2">
          {room.chips.map((c) => (
            <button
              key={c.minor}
              type="button"
              role="radio"
              aria-checked={chip === c.minor}
              disabled={!c.allowed}
              onClick={() => setChip(c.minor)}
              className={cn(
                'min-h-11 min-w-[76px] rounded-full border px-5 text-[15px] font-[680] tabular transition-colors duration-150',
                chip === c.minor ? 'border-ink bg-ink text-paper' : 'border-line bg-surface text-ink hover:border-ink/30',
                !c.allowed && 'cursor-not-allowed opacity-40',
              )}
            >
              {whole(c.minor)}
            </button>
          ))}
        </div>
        {room.roomMinor !== null && room.roomMinor < TOPUP_CHIPS[TOPUP_CHIPS.length - 1] && (
          <p className="mt-4 text-[13.5px] text-muted">
            {noRoom ? "You've reached the limit for unverified accounts." : `You can add up to ${formatUsd(room.roomMinor)} before verifying.`}
            {noRoom && (
              <>
                {' '}
                <button type="button" className="font-[650] text-ink underline decoration-line underline-offset-2" onClick={() => setLimit({ limit: 'balance' })}>
                  See limits
                </button>
              </>
            )}
          </p>
        )}

        {rampOn && (
          <div className="mt-6">
            <Button className="w-full" onClick={openMoonPay} disabled={busy !== null || !chipAllowed || noRoom} aria-busy={busy === 'widget'}>
              {busy === 'widget' ? 'Opening…' : 'Continue'}
            </Button>
            <p className="mt-2 text-center text-[13px] text-muted">You pay with MoonPay. The money lands in your Zecca balance.</p>
            {sandbox && <p className="mt-1 text-center text-[12.5px] text-muted">{SANDBOX_NOTE}</p>}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-4 text-[14.5px] text-alert">
            {error}
          </p>
        )}
      </Panel>

      {config.demoMode && (
        <Panel>
          <span className="label-caps text-muted">Demo credit</span>
          <p className="mt-2 text-[14.5px] text-muted">Try Zecca without a card. Demo credit is not real money.</p>
          <Button variant={rampOn ? 'secondary' : 'primary'} className="mt-4 w-full" onClick={addDemoCredit} disabled={busy !== null || !chipAllowed || noRoom} aria-busy={busy === 'demo'}>
            {busy === 'demo' ? 'Adding…' : `Add ${whole(chip)} demo credit`}
          </Button>
        </Panel>
      )}

      <LimitSheet open={!!limit} onClose={() => setLimit(null)} limits={config.limits} details={limit ?? undefined} verifyHref={config.features.identity ? '/app/identity' : undefined} />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4">
      <h1 className="px-1 text-[22px] font-[740] tracking-[-0.02em]">Add money</h1>
      {children}
    </div>
  )
}

function HomeLink() {
  return (
    <Link href="/app" className="inline-flex min-h-11 items-center rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[650]">
      Back home
    </Link>
  )
}

function TopupSkeleton() {
  return (
    <Shell>
      <div className="gd-panel flex flex-col gap-4" aria-busy="true" aria-label="Loading">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-11 w-40" />
        <div className="flex gap-2">
          <Skeleton className="h-11 w-20 rounded-full" />
          <Skeleton className="h-11 w-20 rounded-full" />
          <Skeleton className="h-11 w-20 rounded-full" />
        </div>
        <Skeleton className="h-12 w-full rounded-[14px]" />
      </div>
    </Shell>
  )
}
