'use client'
// Market asset page (UI.md §3.2, §5.10): Peak Chart "Gold, per gram" with the real daily closes, both prices,
// what you hold in grams, "Buy" / "Sell" (amount sheet with both prices, then ApproveSheet + arches).
// A first purchase of a metal takes two approvals: open the holding, then pay (DECISIONS: market two-step buy).
import { createContext, useCallback, useContext, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { formatUsd, spokenUsd, type Intent, type MarketAsset, type MetalSymbol, type ResponseOf, type ZeccaEvent } from '@zecca/contracts'
import { PeakChart } from '@/components/ui/peak-chart'
import { ApproveSheet, type ApproveOutcome } from '@/components/zecca/approve-sheet'
import { AmountKeypad } from '@/components/zecca/amount-keypad'
import { Button, Skeleton } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { LimitSheet } from '@/components/zecca/limit-sheet'
import { Sheet } from '@/components/zecca/sheet'
import { isApiError, ZeccaApiError, type ApiErrorDetails } from '@/lib/api'
import { useApp } from '@/lib/app'
import { cn } from '@/lib/cn'
import { useLiveEvents, useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { useWide } from '@/lib/use-media'
import { signAndSubmit } from '@/lib/wallet/sign-and-submit'
import { chartLabels, estimate, gramsText, needsAuthorizeFirst, parseGrams, perGram, priceTime, tradeTitle } from './market-model'
import { useChartWidth } from './chart-width'
import { MetalMark, NotAvailable } from './market-screen'
import { Change, Locked, PriceDate } from './parts'

type Side = 'buy' | 'sell'
type OrderRes = ResponseOf<'marketOrder'>

const FollowCtx = createContext<{ intent: Intent | null; side: Side; noun: string }>({ intent: null, side: 'buy', noun: 'metal' })

function FollowLine() {
  const { intent, side, noun } = useContext(FollowCtx)
  if (!intent) return null
  if (intent.status === 'failed') return <span className="text-alert">{intent.failure?.message ?? "This didn't go through."}</span>
  if (side === 'buy') return <span>{intent.status === 'paid_out' ? `The ${noun} is in your holdings.` : `Payment received. Delivering your ${noun}.`}</span>
  return <span>{intent.status === 'paid_out' ? 'The money is on its way to your balance.' : 'Sale received. Paying you out.'}</span>
}

const inputCls =
  'h-14 w-full rounded-[14px] border border-line bg-surface px-4 text-center text-[28px] font-[700] tabular text-ink outline-none focus-visible:border-ink/40 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--brass)]'

export function AssetScreen({ symbol }: { symbol: MetalSymbol }) {
  const { api, config, getSigner } = useApp()
  const session = useSession()
  const wide = useWide()
  const chartWidth = useChartWidth()
  const on = !!config?.features.market
  const assets = useResource(() => api.call('marketAssets'), [api], on)
  const holdings = useResource(() => api.call('marketHoldings'), [api], on)
  const balance = useResource(() => api.call('balance'), [api], on)
  const verified = session?.user?.tier === 1

  const [side, setSide] = useState<Side | null>(null)
  const [unit, setUnit] = useState<'usd' | 'g'>('usd')
  const [usdText, setUsdText] = useState('')
  const [usdMinor, setUsdMinor] = useState<number | null>(null)
  const [gText, setGText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [pending, setPending] = useState<{ res: OrderRes; side: Side } | null>(null)
  const [limit, setLimit] = useState<ApiErrorDetails | null>(null)
  const [followed, setFollowed] = useState<Intent | null>(null)
  const [attempted, setAttempted] = useState(false)

  const followedId = followed?.id
  const onEvent = useCallback(
    (e: ZeccaEvent) => {
      if (e.type === 'balance.updated') balance.setData(e.data)
      if (e.type === 'intent.updated' && e.data.id === followedId) {
        setFollowed(e.data)
        if (e.data.status === 'paid_out' || e.data.status === 'received') holdings.refresh()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [followedId],
  )
  const onPoll = useCallback(() => {
    balance.refresh()
    holdings.refresh()
    if (followedId)
      api
        .call('transferGet', { params: { id: followedId } })
        .then(setFollowed)
        .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, followedId])
  useLiveEvents(onEvent, onPoll)

  if (config && !on) return <NotAvailable />
  const asset = assets.data?.find((a) => a.symbol === symbol)
  const held = holdings.data?.find((h) => h.symbol === symbol)
  const noun = asset?.name.toLowerCase() ?? 'metal'

  const grams = unit === 'g' ? parseGrams(gText) : null
  const by = unit === 'usd' ? (usdMinor ? { amountMinor: usdMinor } : null) : grams ? { quantityMg: grams } : null
  const preview = asset && side && by ? estimate(asset, side, by) : null

  const openTrade = (s: Side) => {
    setSide(s)
    setUnit('usd')
    setUsdText('')
    setUsdMinor(null)
    setGText('')
    setProblem(null)
  }

  const place = async (s: Side) => {
    if (!by) throw new ZeccaApiError(400, { code: 'bad_request', message: 'Enter an amount.' })
    return api.call('marketOrder', { body: { symbol, side: s, ...by } })
  }

  const takeOver = (e: ZeccaApiError): boolean => {
    if (e.code === 'limit_reached' && e.details) {
      setLimit(e.details)
      return true
    }
    return false
  }

  async function onContinue() {
    if (!side || !asset || creating) return
    if (!by) return setProblem(unit === 'g' ? 'Enter grams, up to three decimals.' : 'Enter an amount.')
    if (!preview) return setProblem("That's less than the smallest amount you can trade.")
    if (side === 'sell' && held && preview.quantityMg > held.quantityMg) return setProblem(`You have ${gramsText(held.quantityMg)} of ${noun}.`)
    if (side === 'buy' && balance.data && preview.amountMinor > balance.data.availableMinor) return setProblem(`You need ${formatUsd(preview.amountMinor - balance.data.availableMinor)} more.`)
    setProblem(null)
    setCreating(true)
    try {
      const res = await place(side)
      setAttempted(false)
      setFollowed(null)
      setPending({ res, side })
      setSide(null)
    } catch (e) {
      if (isApiError(e) && takeOver(e)) setSide(null)
      else setProblem(e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.')
    } finally {
      setCreating(false)
    }
  }

  async function approve(): Promise<ApproveOutcome> {
    if (!pending) throw new Error('Start again.')
    const s = pending.side
    let res = pending.res
    // "Try again" after a failure: the old order is closed, so place a new one.
    if (attempted) res = await place(s)
    setAttempted(true)
    const signer = await getSigner()
    if (needsAuthorizeFirst(res)) {
      // First purchase of this metal: open the holding (one approval), then the payment (the second).
      const { tx_blob } = await signer.sign(res.prepared.tx)
      const a = await api.call('txSubmit', { body: { prepareId: res.prepared.prepareId, txBlob: tx_blob } })
      if (a.status !== 'validated' && a.engineResult !== 'tecDUPLICATE')
        throw new ZeccaApiError(422, { code: 'ledger_error', message: `We couldn't open your ${noun} holding. Nothing was taken. Try again.` })
      res = await place(s)
    }
    const r = await signAndSubmit(api, signer, res.prepared)
    setFollowed(r.intent ?? res.intent ?? null)
    setPending({ res, side: s })
    balance.refresh()
    holdings.refresh()
    const q = res.quote
    return s === 'buy'
      ? { title: `Bought. ${gramsText(q.quantityMg)} of ${noun}.`, line: <FollowLine />, announce: `Bought ${gramsText(q.quantityMg)} of ${noun} for ${spokenUsd(q.amountMinor)}` }
      : { title: `Sold. ${formatUsd(q.amountMinor)} on its way.`, line: <FollowLine />, announce: `Sold ${gramsText(q.quantityMg)} of ${noun} for ${spokenUsd(q.amountMinor)}` }
  }

  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link href="/app/market" className="-ml-2 grid size-11 place-items-center rounded-full text-ink hover:bg-ink/5" aria-label="Back to metals">
          <ArrowLeft className="size-5" aria-hidden="true" />
        </Link>
        <MetalMark symbol={symbol} size={34} />
        <h1 className="text-[22px] font-[740] tracking-[-0.02em]">{asset?.name ?? <Skeleton className="h-6 w-24" />}</h1>
      </div>

      {assets.error && (
        <Panel>
          <p className="text-[15px] text-alert" role="alert">
            {assets.error}
          </p>
          <Button variant="secondary" className="mt-3" onClick={assets.reload}>
            Try again
          </Button>
        </Panel>
      )}

      {!asset && !assets.error && <Skeleton className="mx-auto aspect-[540/696] w-full max-w-[340px] rounded-[28px]" />}

      {asset && <Chart asset={asset} width={wide ? 380 : chartWidth} />}

      {asset && (
        <Panel className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <PriceBox label="You buy at" value={perGram(asset.buyPriceMinor)} />
            <PriceBox label="You sell at" value={perGram(asset.sellPriceMinor)} />
          </div>
          <p className="text-[13.5px] text-muted">
            Market price {perGram(asset.priceMinor)}. Zecca&apos;s margin is the difference: {config ? `${(config.fees.marketSpreadBps / 100).toFixed(2).replace(/\.?0+$/, '')}%` : ''} in total, half on each side.
          </p>
          <PriceDate asset={asset} />
        </Panel>
      )}

      {asset && (
        <Panel className="flex items-center justify-between gap-3">
          <span>
            <span className="block text-[13px] text-muted">You hold</span>
            <span className="tabular block text-[22px] font-[740] tracking-[-0.02em]">{held ? gramsText(held.quantityMg) : <Skeleton className="h-6 w-20" />}</span>
          </span>
          {held && held.quantityMg > 0 && (
            <span className="text-right">
              <span className="block text-[13px] text-muted">Worth</span>
              <span className="tabular block text-[17px] font-[680]">{formatUsd(held.valueMinor)}</span>
            </span>
          )}
        </Panel>
      )}

      {asset && session?.user && !verified && <Locked />}
      {asset && verified && (
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={() => openTrade('buy')}>Buy</Button>
          <Button variant="secondary" onClick={() => openTrade('sell')} disabled={!held || held.quantityMg === 0}>
            Sell
          </Button>
        </div>
      )}

      {asset && side && (
        <Sheet open={!!side} onClose={() => setSide(null)} title={`${side === 'buy' ? 'Buy' : 'Sell'} ${noun}`}>
          <div className="flex flex-col items-center gap-3">
            <div className="grid w-full grid-cols-2 gap-2 text-[14px]">
              <PriceBox label="Buy" value={perGram(asset.buyPriceMinor)} strong={side === 'buy'} />
              <PriceBox label="Sell" value={perGram(asset.sellPriceMinor)} strong={side === 'sell'} />
            </div>
            <div role="radiogroup" aria-label="Trade in" className="inline-flex rounded-full border border-line bg-surface p-1">
              {(['usd', 'g'] as const).map((u) => (
                <button
                  key={u}
                  type="button"
                  role="radio"
                  aria-checked={unit === u}
                  onClick={() => (setUnit(u), setProblem(null))}
                  className={cn('min-h-10 rounded-full px-4 text-[14px] font-[650]', unit === u ? 'bg-ink text-paper' : 'text-muted')}
                >
                  {u === 'usd' ? 'Dollars' : 'Grams'}
                </button>
              ))}
            </div>
            {unit === 'usd' ? (
              <AmountKeypad
                value={usdText}
                onChange={(t, m) => (setUsdText(t), setUsdMinor(m), setProblem(null))}
                pad={false}
                error={problem ?? undefined}
                hint={side === 'buy' && balance.data ? `Available ${formatUsd(balance.data.availableMinor)}` : held ? `You hold ${gramsText(held.quantityMg)}` : undefined}
              />
            ) : (
              <div className="flex w-full flex-col gap-1.5">
                <label htmlFor="market-grams" className="label-caps text-center text-muted">
                  Grams
                </label>
                <input id="market-grams" inputMode="decimal" autoComplete="off" className={inputCls} value={gText} placeholder="0.000" onChange={(e) => (setGText(e.target.value), setProblem(null))} />
                <p className={cn('min-h-5 text-center text-[13.5px]', problem ? 'text-alert' : 'text-muted')} role={problem ? 'alert' : undefined}>
                  {problem ?? (held ? `You hold ${gramsText(held.quantityMg)}` : '')}
                </p>
              </div>
            )}
            {side === 'sell' && held && held.quantityMg > 0 && (
              <Button variant="ghost" className="min-h-10 text-[14px]" onClick={() => (setUnit('g'), setGText(gramsText(held.quantityMg).replace(' g', '')), setProblem(null))}>
                Sell all
              </Button>
            )}
            <p className="min-h-5 text-[14px] text-muted" aria-live="polite">
              {preview ? (side === 'buy' ? `About ${gramsText(preview.quantityMg)} for ${formatUsd(preview.amountMinor)}` : `About ${formatUsd(preview.amountMinor)} for ${gramsText(preview.quantityMg)}`) : ''}
            </p>
            <Button className="w-full" onClick={onContinue} disabled={!by} busy={creating}>
              Continue
            </Button>
          </div>
        </Sheet>
      )}

      {pending && asset && (
        <FollowCtx.Provider value={{ intent: followed, side: pending.side, noun }}>
          <ApproveSheet
            open={!!pending}
            onClose={() => setPending(null)}
            title={tradeTitle(pending.side, asset.name, pending.res.quote)}
            subline={`at ${perGram(pending.res.quote.unitPriceMinor)}`}
            feeMinor={pending.res.quote.spreadMinor}
            expectedMs={needsAuthorizeFirst(pending.res) ? 16_000 : 10_000}
            details={
              <div className="flex flex-col gap-2 text-[14px]">
                <Row k={pending.side === 'buy' ? 'You pay' : 'You receive'} v={formatUsd(pending.res.quote.amountMinor)} />
                <Row k="Price per gram" v={formatUsd(pending.res.quote.unitPriceMinor)} />
                <p className="text-[13px] text-muted">The fee is Zecca&apos;s margin, already in the price.</p>
                {needsAuthorizeFirst(pending.res) && (
                  <p className="rounded-[12px] bg-paper px-3 py-2 text-[13.5px] text-ink">
                    Your first {noun} purchase takes two approvals: one opens your {noun} holding, the other pays.
                  </p>
                )}
                {pending.side === 'sell' && <p className="text-[13px] text-muted">The metal goes back to Zecca in public; the dollars reach you privately.</p>}
              </div>
            }
            run={approve}
            onError={takeOver}
          />
        </FollowCtx.Provider>
      )}
      {config && <LimitSheet open={!!limit} onClose={() => setLimit(null)} limits={config.limits} details={limit ?? undefined} verifyHref={config.features.identity ? '/app/identity' : undefined} />}
    </div>
  )
}

function Chart({ asset, width }: { asset: MarketAsset; width: number }) {
  const h = asset.history
  if (h.length < 2)
    return (
      <Panel className="text-center">
        <p className="text-[13px] text-muted">{asset.name}, per gram</p>
        <p className="tabular text-[36px] font-[760] tracking-[-0.03em]">{formatUsd(asset.priceMinor)}</p>
        <Change pct={asset.change24hPct} />
      </Panel>
    )
  const pct = asset.change24hPct ?? 0
  // The card's glow paints beyond its width: clip it at the screen edge so a phone never scrolls sideways.
  return (
    <div className="-mx-4 flex justify-center overflow-x-clip px-4">
      <PeakChart
        width={width}
        data={h}
        labels={chartLabels(h.length)}
        // Display only: the headline takes dollars; the prices stay integer cents everywhere else.
        value={asset.priceMinor / 100}
        valuePrefix="$"
        valueSuffix=""
        decimals={2}
        title={`${asset.name}, per gram`}
        caption={`Buy ${formatUsd(asset.buyPriceMinor)} · Sell ${formatUsd(asset.sellPriceMinor)}`}
        updatedText={`Price at ${priceTime(asset.priceAt)}`}
        trend={pct > 0 ? 'up' : pct < 0 ? 'down' : 'none'}
        periods={['Daily closes']}
        period="Daily closes"
        accent="#A8842F"
        font='"Manrope Variable", Manrope, system-ui, sans-serif'
        formatValue={(v) => formatUsd(Math.max(0, Math.round(v)))}
      />
    </div>
  )
}

function PriceBox({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={cn('rounded-[14px] border px-3 py-2.5', strong ? 'border-ink/40 bg-surface' : 'border-line')}>
      <p className="text-[12.5px] text-muted">{label}</p>
      <p className="tabular text-[16px] font-[700]">{value}</p>
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{k}</span>
      <span className="tabular font-[650]">{v}</span>
    </div>
  )
}
