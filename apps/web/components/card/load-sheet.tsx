'use client'
// "Load card" (UI.md §5.10): an amount sheet, then one approval with the arches. The money goes from the balance to the
// Zecca pool like any payment; the card balance shows it once the pool has confirmed it (SPEC §4.6).
import { useEffect, useState } from 'react'
import { formatUsd, spokenUsd, type Limits } from '@zecca/contracts'
import { ApproveSheet } from '@/components/zecca/approve-sheet'
import { AmountKeypad } from '@/components/zecca/amount-keypad'
import { Button } from '@/components/zecca/bits'
import { LimitSheet } from '@/components/zecca/limit-sheet'
import { Sheet } from '@/components/zecca/sheet'
import type { ApiErrorDetails } from '@/lib/api'
import { useApp } from '@/lib/app'
import { signAndSubmit } from '@/lib/wallet/sign-and-submit'

const CHIPS = [1000, 2000, 5000]

export function LoadSheet({
  open,
  onClose,
  availableMinor,
  limits,
  verifyHref,
  onLoaded,
}: {
  open: boolean
  onClose: () => void
  availableMinor: number | null
  limits?: Limits
  verifyHref?: string
  onLoaded: (amountMinor: number) => void
}) {
  const { api, getSigner } = useApp()
  const [text, setText] = useState('')
  const [minor, setMinor] = useState<number | null>(null)
  const [approve, setApprove] = useState(false)
  const [limit, setLimit] = useState<ApiErrorDetails | null>(null)

  useEffect(() => {
    if (open) {
      setText('')
      setMinor(null)
    }
  }, [open])

  const tooMuch = minor !== null && availableMinor !== null && minor > availableMinor
  const error = tooMuch ? `You have ${formatUsd(availableMinor!)} available.` : undefined
  const ok = minor !== null && minor > 0 && !tooMuch

  return (
    <>
      <Sheet open={open && !approve} onClose={onClose} title="Load card">
        <div className="flex flex-col items-center">
          <AmountKeypad
            value={text}
            onChange={(t, m) => {
              setText(t)
              setMinor(m)
            }}
            label="Amount to move"
            error={error}
            hint={availableMinor !== null ? `Available ${formatUsd(availableMinor)}` : undefined}
          />
          <div className="mt-2 flex gap-2" role="group" aria-label="Quick amounts">
            {CHIPS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setText(String(c / 100))
                  setMinor(c)
                }}
                className="min-h-11 rounded-full border border-line bg-surface px-4 text-[14px] font-[650] hover:border-ink/30"
              >
                {formatUsd(c).replace('.00', '')}
              </button>
            ))}
          </div>
          <Button className="mt-5 w-full" disabled={!ok} onClick={() => setApprove(true)}>
            Continue
          </Button>
        </div>
      </Sheet>

      <ApproveSheet
        open={open && approve && minor !== null}
        onClose={() => {
          setApprove(false)
          onClose()
        }}
        title={`Move ${formatUsd(minor ?? 0)} to your card`}
        subline="From your Zecca balance"
        feeMinor={0}
        run={async () => {
          const amountMinor = minor!
          const { prepared } = await api.call('cardLoad', { body: { amountMinor } })
          await signAndSubmit(api, await getSigner(), prepared)
          onLoaded(amountMinor)
          return {
            title: `Moved. ${formatUsd(amountMinor)} to your card.`,
            line: 'It shows on the card in a few seconds. Every purchase after that is instant.',
            announce: `Moved, ${spokenUsd(amountMinor)} to your card`,
          }
        }}
        onError={(e) => {
          if (e.code !== 'limit_reached' || !limits) return false
          setLimit(e.details ?? {})
          return true
        }}
      />

      {limits && <LimitSheet open={!!limit} onClose={() => setLimit(null)} limits={limits} details={limit ?? undefined} verifyHref={verifyHref} />}
    </>
  )
}
