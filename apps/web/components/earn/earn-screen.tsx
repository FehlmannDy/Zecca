'use client'
// Earn (UI.md §5.10, SPEC §4.7): the position in XRP with a dollar estimate, "Add to Earn", "Withdraw", the fees before
// approving, the two honest lines, the "opening" state with the arches while Flare executes (~3 min). Tier 1 only.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { Clock3, RotateCw, ShieldCheck } from 'lucide-react'
import { formatUsd, type ZeccaEvent } from '@zecca/contracts'
import { PeakChart } from '@/components/ui/peak-chart'
import { useApp } from '@/lib/app'
import { useLiveEvents, useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { useWide } from '@/lib/use-media'
import { ArchesProgress } from '@/components/zecca/arches'
import { Button, EmptyState, HashChip, Skeleton } from '@/components/zecca/bits'
import { Badge, Panel } from '@/components/zecca/glass'
import { AddToEarnSheet } from './add-sheet'
import { WithdrawSheet } from './withdraw-sheet'
import { chartSeries, EXPLORERS, feeLine, OPENING_MS, pollEvery, rateText, statusLine, timeText, xrpText } from './earn-model'
import { useEarnApi } from './use-earn-api'

const HONEST = ['Earnings are paid in XRP and their dollar value moves with its price.', 'Withdrawals take a few hours.']

export function EarnScreen() {
  const { config } = useApp()
  const earn = useEarnApi()
  const user = useSession()?.user
  const wide = useWide()
  const on = !!config?.features.earn
  const verified = user?.tier === 1
  const pos = useResource(() => earn.position(), [earn], on && verified)
  const [adding, setAdding] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)

  const p = pos.data
  const every = p ? pollEvery(p) : null
  useEffect(() => {
    if (!every) return
    const id = setInterval(pos.refresh, every)
    return () => clearInterval(id)
  }, [every]) // eslint-disable-line react-hooks/exhaustive-deps

  const onEvent = useCallback((e: ZeccaEvent) => {
    if (e.type === 'intent.updated' && e.data.kind === 'earn_deposit') pos.refresh()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useLiveEvents(onEvent, pos.refresh)

  if (!config || !user) return <EarnSkeleton />
  if (!on) {
    return (
      <Frame>
        <Panel className="flex flex-col items-start gap-4">
          <p className="text-[15px] text-muted">Earn is not available yet.</p>
          <HomeLink />
        </Panel>
      </Frame>
    )
  }
  if (!verified) {
    return (
      <Frame>
        <Panel className="flex flex-col items-start gap-4">
          <span className="grid size-11 place-items-center rounded-full border border-line">
            <ShieldCheck className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-[20px] font-[740] tracking-[-0.02em]">Verify your identity to use Earn.</h2>
            <p className="mt-2 text-[15px] text-muted">{HONEST[0]}</p>
          </div>
          {config.features.identity ? (
            <Link href="/app/identity" className="inline-flex min-h-12 items-center rounded-[14px] bg-ink px-5 text-[15px] font-[680] text-paper">
              Verify your identity
            </Link>
          ) : (
            <p className="text-[14px] text-muted">Identity checks open soon.</p>
          )}
        </Panel>
      </Frame>
    )
  }
  if (pos.error && !p) {
    return (
      <Frame>
        <Panel className="flex flex-col items-start gap-3" role="alert">
          <p className="text-[15px]">{pos.error}</p>
          <Button variant="secondary" onClick={pos.reload}>
            <RotateCw className="size-4" aria-hidden="true" /> Retry
          </Button>
        </Panel>
      </Frame>
    )
  }
  if (!p) return <EarnSkeleton />

  const series = chartSeries(p.history)
  const inFlight = p.status === 'funding' || p.status === 'opening'
  const empty = p.status === 'none' && p.valueDrops === 0 && !p.pendingWithdrawal
  const canWithdraw = p.valueDrops > 0 && !p.pendingWithdrawal && !inFlight
  const mock = p.mode === 'mock'

  const headline =
    series.data.length >= 2 && p.valueDrops > 0 ? (
      <div className="flex justify-center">
        <PeakChart
          width={wide ? 380 : 320}
          data={series.data}
          labels={series.labels}
          // Display only: the headline takes XRP; every amount above stays in integer drops.
          value={p.valueDrops / 1_000_000}
          valueSuffix=" XRP"
          decimals={2}
          title={mock ? 'Test position' : 'Your position'}
          caption={`About ${formatUsd(p.valueUsdMinor)}`}
          updatedText={p.stale ? 'Last read' : 'Live from the vault'}
          trend="none"
          periods={['All']}
          period="All"
          accent="#A8842F"
          font='"Manrope Variable", Manrope, system-ui, sans-serif'
          formatValue={(v) => `${xrpText(Math.max(0, Math.round(v)))} XRP`}
        />
      </div>
    ) : (
      <Panel aria-labelledby="earn-value">
        <span id="earn-value" className="label-caps text-muted">
          {mock ? 'Test position' : 'Your position'}
        </span>
        <p className="tabular mt-2 text-[44px] font-[720] leading-none tracking-[-0.04em]" aria-live="polite">
          {xrpText(p.valueDrops)}
          <span className="ml-1.5 text-[22px] font-[600] text-muted">XRP</span>
        </p>
        <p className="mt-2 text-[15px] text-muted">About {formatUsd(p.valueUsdMinor)}</p>
      </Panel>
    )

  return (
    <Frame mock={mock}>
      {empty && !p.lastFailure ? (
        <Panel>
          <EmptyState title="Nothing in Earn yet. Add dollars and they are put to work in a yield vault." action={<Button onClick={() => setAdding(true)}>Add to Earn</Button>} />
        </Panel>
      ) : (
        headline
      )}

      {inFlight && (
        <Panel className="flex flex-col items-center gap-3 text-center" aria-live="polite">
          <ArchesProgress state="running" expectedMs={p.status === 'opening' ? OPENING_MS : 20_000} className="h-11" label={statusLine(p) ?? 'In progress'} />
          <p className="text-[15px] font-[650]">{statusLine(p)}</p>
          {p.inFlight && (
            <p className="text-[14px] text-muted">
              {formatUsd(p.inFlight.amountMinor)} as {xrpText(p.inFlight.xrpDrops)} XRP
            </p>
          )}
        </Panel>
      )}

      {p.pendingWithdrawal && (
        <Panel className="flex items-start gap-3">
          <Clock3 className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden="true" />
          <div>
            <p className="text-[15px] font-[650]">Requested, available in a few hours</p>
            <p className="mt-1 text-[14px] text-muted">
              {xrpText(p.pendingWithdrawal.amountDrops)} XRP. Available after {timeText(p.pendingWithdrawal.claimableAt)}; then the dollars come back to your balance.
            </p>
          </div>
        </Panel>
      )}

      {p.lastFailure && (
        <p className="px-1 text-[15px] text-alert" role="alert">
          {p.lastFailure}
        </p>
      )}

      {!empty && (
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => setAdding(true)}>Add to Earn</Button>
          <Button variant="secondary" disabled={!canWithdraw} onClick={() => setWithdrawing(true)}>
            Withdraw
          </Button>
        </div>
      )}

      <Panel className="flex flex-col gap-2 text-[14px] text-muted">
        {p.depositedDrops > 0 && (
          <p className="flex justify-between text-ink">
            <span className="text-muted">Deposited</span>
            <span className="tabular font-[650]">{xrpText(p.depositedDrops)} XRP</span>
          </p>
        )}
        <p className="font-[600] text-ink">{feeLine(config.fees)}</p>
        {HONEST.map((l) => (
          <p key={l}>{l}</p>
        ))}
        {p.rate && <p>Rate: {rateText(p.rate)}</p>}
      </Panel>

      {p.ledger && (
        <Panel title="What the ledger shows" subtitle="XRPL Testnet and Flare Coston2">
          <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2.5 text-[14px]">
            <dt className="text-muted">Your Testnet wallet</dt>
            <dd className="justify-self-end">
              <HashChip value={p.ledger.testnetAddress} />
            </dd>
            {p.ledger.smartAccount && (
              <>
                <dt className="text-muted">Smart account</dt>
                <dd className="justify-self-end">
                  <HashChip value={p.ledger.smartAccount} href={mock ? undefined : EXPLORERS.coston2Address + p.ledger.smartAccount} />
                </dd>
              </>
            )}
            {p.ledger.lastPaymentHash && (
              <>
                <dt className="text-muted">Last payment</dt>
                <dd className="justify-self-end">
                  <HashChip value={p.ledger.lastPaymentHash} href={mock ? undefined : EXPLORERS.testnetTx + p.ledger.lastPaymentHash} />
                </dd>
              </>
            )}
          </dl>
        </Panel>
      )}

      <AddToEarnSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false)
          pos.refresh()
        }}
      />
      <WithdrawSheet
        open={withdrawing}
        onClose={() => setWithdrawing(false)}
        position={p}
        onRequested={() => {
          setWithdrawing(false)
          pos.refresh()
        }}
      />
    </Frame>
  )
}

function Frame({ children, mock }: { children: React.ReactNode; mock?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4">
      <div className="flex items-center justify-between px-1">
        <h1 className="text-[26px] font-[740] tracking-[-0.03em]">Earn</h1>
        {mock && <Badge tone="brass">Test position</Badge>}
      </div>
      {children}
    </div>
  )
}

function HomeLink() {
  return (
    <Link href="/app" className="inline-flex min-h-11 items-center rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[650]">
      Go to home
    </Link>
  )
}

function EarnSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[560px] flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-9 w-24" />
      <Skeleton className="h-44 w-full rounded-[20px]" />
      <Skeleton className="h-12 w-full rounded-[14px]" />
      <Skeleton className="h-32 w-full rounded-[20px]" />
    </div>
  )
}
