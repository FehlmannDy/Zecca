'use client'
// Withdraw to a card (SPEC §4.5, FEATURE_WITHDRAW): amount chips, "Continue" opens MoonPay's sell widget as an overlay
// (session and signature from our API). When MoonPay asks for the deposit (onInitiateDeposit), the widget closes and the
// user approves the dollars in Zecca's own sheet; the status follows "Sent to MoonPay" -> "Paid out to your card".
// Hidden (not available) when features.withdraw or features.ramp is off. Sandbox only: no real money moves.
import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { formatUsd, spokenUsd } from '@zecca/contracts'
import { loadMoonPaySdk } from '@/components/topup/moonpay-sdk'
import { Amount } from '@/components/zecca/amount'
import { ApproveSheet } from '@/components/zecca/approve-sheet'
import { ArchesProgress } from '@/components/zecca/arches'
import { Button, EmptyState, Skeleton } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { LimitSheet } from '@/components/zecca/limit-sheet'
import { isApiError, type ApiErrorDetails } from '@/lib/api'
import { useApp } from '@/lib/app'
import { cn } from '@/lib/cn'
import { useResource } from '@/lib/hooks'
import { sessionStore, useSession } from '@/lib/session'
import { signAndSubmit } from '@/lib/wallet/sign-and-submit'
import { WITHDRAW_CHIPS, createWithdrawApi, depositRequest, isFinal, statusCopy, withdrawChips, type DepositResponse, type WithdrawalView } from './withdraw'

const SANDBOX_NOTE = 'Sandbox. No real money moves.'
const REGION = "Withdrawals aren't available in your country yet."
const NO_WIDGET = "MoonPay didn't load. Try again in a moment."
const POLL_MS = 3000
const whole = (minor: number) => (minor % 100 === 0 ? `$${minor / 100}` : formatUsd(minor))

/** The MoonPay web SDK's sell widget, as far as we use it. */
type SellWidget = { show(): void; close?(): void; generateUrlForSigning(): string; updateSignature(signature: string): void }
type SellSdk = {
  init(o: {
    flow: 'sell'
    environment: 'sandbox' | 'production'
    variant: 'overlay'
    params: Record<string, string>
    handlers?: {
      onInitiateDeposit?: (props: unknown) => Promise<{ depositId: string }>
      onUnsupportedRegion?: () => Promise<void>
      onClose?: () => Promise<void>
    }
  }): SellWidget
}

export function WithdrawScreen() {
  const { api, config, getSigner } = useApp()
  const user = useSession()?.user
  const balance = useResource(() => api.call('balance'), [api])
  const withdrawApi = useMemo(() => createWithdrawApi({ origin: api.origin, getToken: () => sessionStore().get()?.token }), [api])
  const [chip, setChip] = useState<number>(WITHDRAW_CHIPS[0])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [limit, setLimit] = useState<ApiErrorDetails | null>(null)
  /** MoonPay asked for the deposit: the approve sheet is open for it. */
  const [pending, setPending] = useState<DepositResponse | null>(null)
  /** Approved: the status screen follows it. */
  const [tracking, setTracking] = useState<WithdrawalView | null>(null)
  const approved = useRef<WithdrawalView | null>(null)
  const widget = useRef<SellWidget | null>(null)

  useEffect(() => {
    if (!tracking || isFinal(tracking.status)) return
    const id = tracking.id
    const t = setInterval(() => {
      withdrawApi
        .status(id)
        .then((v) => {
          setTracking(v)
          if (isFinal(v.status)) balance.refresh()
        })
        .catch(() => {}) // the next poll tries again
    }, POLL_MS)
    return () => clearInterval(t)
  }, [tracking?.id, tracking?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeWidget = () => {
    try {
      widget.current?.close?.()
    } catch {
      /* already closed */
    }
    widget.current = null
  }

  const failWith = (e: unknown) => {
    if (isApiError(e) && e.code === 'limit_reached') setLimit(e.details ?? {})
    else setError(e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.')
  }

  async function openMoonPay() {
    setBusy(true)
    setError(null)
    try {
      const s = await api.call('rampSession', { body: { direction: 'sell', fiatAmount: chip / 100, fiatCurrency: 'usd' } })
      let sdk: SellSdk
      try {
        if (!s.params) throw new Error('no SDK params')
        sdk = (await loadMoonPaySdk()) as unknown as SellSdk
      } catch {
        // Unlike a purchase, a sale cannot finish in another tab: the deposit has to come back to this page.
        setError(NO_WIDGET)
        return
      }
      const w = sdk.init({
        flow: 'sell',
        environment: new URL(s.widgetUrl).hostname.includes('-sandbox') ? 'sandbox' : 'production',
        variant: 'overlay',
        params: s.params!,
        handlers: {
          onInitiateDeposit: async (props) => {
            const req = depositRequest(s.externalId, props)
            closeWidget() // the approval happens in Zecca's own sheet
            if (!req) {
              setError('MoonPay did not say which withdrawal this is. Start again.')
              throw new Error('no transactionId in onInitiateDeposit')
            }
            try {
              const d = await withdrawApi.deposit(req)
              approved.current = null
              setPending(d)
              return { depositId: d.withdrawal.id }
            } catch (e) {
              failWith(e)
              throw e
            }
          },
          onUnsupportedRegion: async () => {
            closeWidget()
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
      setBusy(false)
    }
  }

  if (!config || !user) return <WithdrawSkeleton />
  if (!config.features.withdraw || !config.features.ramp) {
    return (
      <Shell>
        <Panel>
          <EmptyState title="Withdrawals are not available yet." action={<HomeLink />} />
        </Panel>
      </Shell>
    )
  }

  if (tracking) {
    const copy = statusCopy(tracking)
    const final = isFinal(tracking.status)
    return (
      <Shell>
        <Panel className="flex flex-col items-center px-6 py-8 text-center">
          <ArchesProgress state={copy.arches} expectedMs={30_000} label="Withdrawal progress" />
          <div aria-live="polite" className="mt-6">
            <p className="text-[20px] font-[740] tracking-[-0.02em]">{copy.title}</p>
            <p className={cn('mx-auto mt-2 max-w-[34ch] text-[15px]', tracking.status === 'failed' ? 'text-alert' : 'text-muted')} role={tracking.status === 'failed' ? 'alert' : undefined}>
              {copy.body}
            </p>
          </div>
          {(final || tracking.status === 'sent') && (
            <div className="mt-7 flex w-full flex-col gap-2 sm:flex-row">
              <Link href="/app" className="inline-flex min-h-12 flex-1 items-center justify-center rounded-[14px] bg-ink px-5 text-[15px] font-[680] text-paper hover:opacity-90">
                Done
              </Link>
              {final && (
                <Button variant="secondary" className="flex-1" onClick={() => setTracking(null)}>
                  {tracking.status === 'failed' ? 'Try again' : 'Withdraw more'}
                </Button>
              )}
            </div>
          )}
          <p className="mt-6 text-[12.5px] text-muted">{SANDBOX_NOTE}</p>
        </Panel>
      </Shell>
    )
  }

  const b = balance.data
  const chips = withdrawChips({ tier: user.tier, availableMinor: b?.availableMinor ?? null, limits: config.limits })
  const chipAllowed = chips.find((c) => c.minor === chip)?.allowed ?? true
  const capped = chips.some((c) => c.why === 'limit')

  return (
    <Shell>
      <Panel>
        <span id="withdraw-amount" className="label-caps text-muted">
          Amount
        </span>
        <div className="mt-2" aria-live="polite">
          <Amount minor={chip} size="xl" />
        </div>
        {b && <p className="mt-1 text-[13.5px] text-muted">Available {formatUsd(b.availableMinor)}</p>}
        <div role="radiogroup" aria-labelledby="withdraw-amount" className="mt-5 flex flex-wrap gap-2">
          {chips.map((c) => (
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
        {capped && user.tier === 0 && (
          <p className="mt-4 text-[13.5px] text-muted">
            Unverified accounts can withdraw up to {formatUsd(config.limits.tier0.txCapMinor)} at a time.{' '}
            <button type="button" className="font-[650] text-ink underline decoration-line underline-offset-2" onClick={() => setLimit({ limit: 'per_payment' })}>
              See limits
            </button>
          </p>
        )}
        <div className="mt-6">
          <Button className="w-full" onClick={openMoonPay} disabled={busy || !chipAllowed} aria-busy={busy}>
            {busy ? 'Opening…' : 'Continue'}
          </Button>
          <p className="mt-2 text-center text-[13px] text-muted">MoonPay pays it out to your card, minus its fees.</p>
          <p className="mt-1 text-center text-[12.5px] text-muted">{SANDBOX_NOTE}</p>
        </div>
        {error && (
          <p role="alert" className="mt-4 text-[14.5px] text-alert">
            {error}
          </p>
        )}
      </Panel>

      {pending && (
        <ApproveSheet
          open={!!pending}
          onClose={() => {
            const done = approved.current
            setPending(null)
            if (done) setTracking({ ...done, status: done.status === 'approve' ? 'sending' : done.status })
          }}
          title={`Withdraw ${formatUsd(pending.intent.amountMinor)} to your card`}
          subline="Paid out by MoonPay"
          feeMinor={0}
          run={async () => {
            await signAndSubmit(api, await getSigner(), pending.prepared)
            approved.current = pending.withdrawal
            balance.refresh()
            return {
              title: `Approved. ${formatUsd(pending.intent.amountMinor)} to MoonPay.`,
              line: 'MoonPay pays it out to your card.',
              announce: `Approved, ${spokenUsd(pending.intent.amountMinor)} to MoonPay`,
            }
          }}
          onError={(e) => {
            if (e.code !== 'limit_reached') return false
            setLimit(e.details ?? {})
            return true
          }}
        />
      )}

      <LimitSheet open={!!limit} onClose={() => setLimit(null)} limits={config.limits} details={limit ?? undefined} verifyHref={config.features.identity ? '/app/identity' : undefined} />
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4">
      <h1 className="px-1 text-[22px] font-[740] tracking-[-0.02em]">Withdraw to a card</h1>
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

function WithdrawSkeleton() {
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
