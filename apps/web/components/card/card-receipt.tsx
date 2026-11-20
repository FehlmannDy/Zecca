'use client'
// A card payment opens as a receipt (UI.md §5.10, SPEC §4.14): shop name, amount, time, "Card ending 4417",
// "Authorised" then "Completed", reference.
import type { CardAuthorization } from '@zecca/contracts'
import { Amount } from '@/components/zecca/amount'
import { HashChip } from '@/components/zecca/bits'
import { Sheet } from '@/components/zecca/sheet'
import { cn } from '@/lib/cn'
import { authLine, authStatusLabel } from './card-logic'

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

export function CardReceipt({ auth, last4, onClose }: { auth: CardAuthorization | null; last4: string; onClose: () => void }) {
  const a = auth
  return (
    <Sheet open={!!a} onClose={onClose} title="Receipt">
      {a && (
        <div className="flex flex-col">
          <div className="flex flex-col items-center gap-1 border-b border-dashed border-line pb-5 text-center">
            <p className="text-[19px] font-[720] tracking-[-0.02em]">{a.merchant}</p>
            <Amount minor={a.amountMinor} size="xl" direction={a.status === 'refunded' ? 'in' : undefined} />
            <p className={cn('mt-1 text-[14px] font-[650]', a.status === 'declined' ? 'text-alert' : 'text-muted')}>{authLine(a)}</p>
          </div>
          <dl className="divide-y divide-line text-[15px]">
            {[
              ['Time', when(a.at)],
              ['Paid with', `Card ending ${last4}`],
              ['Status', authStatusLabel(a.status)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-4 py-3">
                <dt className="text-muted">{k}</dt>
                <dd className="text-right font-[650]">{v}</dd>
              </div>
            ))}
            <div className="flex items-center justify-between gap-4 py-3">
              <dt className="text-muted">Reference</dt>
              <dd>
                <HashChip value={a.id} label="Copy reference" />
              </dd>
            </div>
          </dl>
          {a.status === 'authorised' && <p className="mt-2 text-[13px] text-muted">Approved. It shows as completed once the shop settles the payment.</p>}
        </div>
      )}
    </Sheet>
  )
}
