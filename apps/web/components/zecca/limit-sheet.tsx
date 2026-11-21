'use client'
// UI.md §5.12: a sheet, not an error toast, when a tier 0 account hits a cap. The limit that was hit is
// highlighted, from ApiError.details.limit. Any other limit (a verified payer, a recipient who can't receive that much)
// is said in one plain sentence instead (limit-view.ts).
import Link from 'next/link'
import { formatUsd, type Limits, type LimitName } from '@zecca/contracts'
import type { ApiErrorDetails } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useSession } from '@/lib/session'
import { Button } from './bits'
import { limitView } from './limit-view'
import { Sheet } from './sheet'

const ROWS: { key: LimitName; label: string; cap: (l: Limits) => number }[] = [
  { key: 'balance', label: 'Balance', cap: (l) => l.tier0.balanceCapMinor },
  { key: 'per_payment', label: 'Per payment', cap: (l) => l.tier0.txCapMinor },
  { key: 'monthly_send', label: 'Sent per month', cap: (l) => l.tier0.monthlySendCapMinor },
]

export function LimitSheet({
  open,
  onClose,
  limits,
  details,
  verifyHref,
  message,
}: {
  open: boolean
  onClose: () => void
  limits: Limits
  details?: ApiErrorDetails
  /** Where "Verify your identity" goes; leave out while identity is switched off. */
  verifyHref?: string
  /** The API's error.message, shown as is when the limit is not one of the viewer's own tier 0 caps. */
  message?: string
}) {
  const tier = useSession()?.user?.tier
  const view = limitView({ tier, limits, details, message })
  if (view.kind === 'other')
    return (
      <Sheet open={open} onClose={onClose} title={view.title}>
        <p className="text-[15px] text-ink" role="alert">
          {view.line}
        </p>
        <Button className="mt-6 w-full" onClick={onClose} data-autofocus>
          OK
        </Button>
      </Sheet>
    )
  const hit = view.hit
  return (
    <Sheet open={open} onClose={onClose} title="You've reached the limit for unverified accounts.">
      <ul className="divide-y divide-line rounded-[16px] border border-line">
        {ROWS.map((r) => {
          const isHit = hit === r.key
          return (
            <li key={r.key} className={cn('flex items-center justify-between gap-3 px-4 py-3.5 text-[15px]', isHit && 'bg-paper')} aria-current={isHit ? 'true' : undefined}>
              <span className={cn(isHit ? 'font-[700] text-ink' : 'text-muted')}>
                {r.label}
                {isHit && <span className="ml-2 rounded-full bg-ink px-2 py-0.5 text-[11px] font-[700] text-paper">Reached</span>}
              </span>
              <span className={cn('tabular', isHit ? 'font-[700]' : 'text-muted')}>{formatUsd(r.cap(limits))}</span>
            </li>
          )
        })}
      </ul>
      <div className="mt-6 flex flex-col gap-2">
        {verifyHref ? (
          <Link href={verifyHref} className="inline-flex min-h-12 items-center justify-center rounded-[14px] bg-ink px-5 text-[15px] font-[680] text-paper hover:opacity-90" data-autofocus>
            Verify your identity
          </Link>
        ) : (
          <Button disabled className="w-full" aria-describedby="verify-soon">
            Verify your identity
          </Button>
        )}
        {!verifyHref && (
          <p id="verify-soon" className="text-center text-[13px] text-muted">
            Identity checks are not available yet.
          </p>
        )}
        <Button variant="ghost" className="w-full" onClick={onClose}>
          Not now
        </Button>
      </div>
    </Sheet>
  )
}
