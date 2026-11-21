'use client'
// "Add to Earn": the amount, then the quote and the fees before the one approval (UI.md §5.10, SPEC §4.7, §4.13).
import { useEffect, useState } from 'react'
import { formatUsd, spokenUsd } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { isApiError, type ApiErrorDetails } from '@/lib/api'
import { signAndSubmit } from '@/lib/wallet/sign-and-submit'
import { cn } from '@/lib/cn'
import { AmountKeypad } from '@/components/zecca/amount-keypad'
import { ApproveSheet } from '@/components/zecca/approve-sheet'
import { Button } from '@/components/zecca/bits'
import { LimitSheet } from '@/components/zecca/limit-sheet'
import { Sheet } from '@/components/zecca/sheet'
import { feeLine, percentText, rateText, xrpText } from './earn-model'
import type { EarnDepositView } from './earn-api'
import { useEarnApi } from './use-earn-api'

const CHIPS = [1000, 2500, 5000]

type Prepared = EarnDepositView

export function AddToEarnSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const { api, config, getSigner } = useApp()
  const earn = useEarnApi()
  const [text, setText] = useState('')
  const [minor, setMinor] = useState<number | null>(null)
  const [error, setError] = useState<string | undefined>()
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState<Prepared | null>(null)
  const [limit, setLimit] = useState<ApiErrorDetails | null>(null)

  useEffect(() => {
    if (!open) return
    setText('')
    setMinor(null)
    setError(undefined)
    setReady(null)
  }, [open])

  async function review() {
    if (!minor) return
    setBusy(true)
    setError(undefined)
    try {
      setReady(await earn.deposit(minor))
    } catch (e) {
      if (isApiError(e) && e.code === 'limit_reached') setLimit(e.details ?? {})
      else setError(e instanceof Error && e.message ? e.message : "That didn't work. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const q = ready?.quote
  const fees = config?.fees
  return (
    <>
      <Sheet open={open && !ready && !limit} onClose={onClose} title="Add to Earn">
        <div className="flex flex-col items-center gap-4">
          <div className="flex gap-2" role="group" aria-label="Amounts">
            {CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setText(String(c / 100))
                  setMinor(c)
                  setError(undefined)
                }}
                className={cn('min-h-11 rounded-full border px-4 text-[14px] font-[650]', minor === c ? 'border-ink bg-ink text-paper' : 'border-line bg-surface text-ink')}
              >
                {formatUsd(c).replace('.00', '')}
              </button>
            ))}
          </div>
          <AmountKeypad
            value={text}
            onChange={(t, m) => {
              setText(t)
              setMinor(m)
              setError(undefined)
            }}
            error={error}
            hint="Converted to XRP at the rate shown next."
          />
          <Button className="w-full" disabled={!minor} busy={busy} onClick={review}>
            {busy ? 'Getting the rate…' : 'Continue'}
          </Button>
        </div>
      </Sheet>

      {ready && q && (
        <ApproveSheet
          open={open && !!ready}
          onClose={() => {
            setReady(null)
            onClose()
          }}
          title={`Add ${formatUsd(ready.intent.amountMinor)} to Earn`}
          subline={`You get about ${xrpText(q.xrpDrops)} XRP`}
          feeMinor={q.swapFeeMinor}
          expectedMs={12_000}
          details={
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-[16px] border border-line px-4 py-3 text-[14px]">
              <dt className="text-muted">Rate</dt>
              <dd className="text-right">
                {q.microUsdPerXrp && q.rateAt && q.rateSource ? rateText({ microUsdPerXrp: q.microUsdPerXrp, at: q.rateAt, source: q.rateSource, minorPerXrp: q.rateMinorPerXrp }) : `${formatUsd(q.rateMinorPerXrp)} per XRP`}
              </dd>
              {fees && (
                <>
                  <dt className="text-muted">Conversion</dt>
                  <dd className="text-right">{percentText(fees.earnSwapBps)}</dd>
                  <dd className="col-span-2 border-t border-line pt-2 text-muted">{feeLine(fees)}</dd>
                </>
              )}
            </dl>
          }
          run={async () => {
            const signer = await getSigner()
            await signAndSubmit(api, signer, ready.prepared)
            const amount = ready.intent.amountMinor
            return {
              title: `Added. ${formatUsd(amount)} to Earn.`,
              line: 'Opening your Earn account takes about 3 minutes.',
              announce: `Added, ${spokenUsd(amount)} to Earn`,
            }
          }}
          onDone={onAdded}
          onError={(e) => {
            if (e.code !== 'limit_reached') return false
            setLimit(e.details ?? {})
            return true
          }}
        />
      )}

      {config && (
        <LimitSheet
          open={!!limit}
          onClose={() => {
            setLimit(null)
            onClose()
          }}
          limits={config.limits}
          details={limit ?? undefined}
          verifyHref={config.features.identity ? '/app/identity' : undefined}
        />
      )}
    </>
  )
}
