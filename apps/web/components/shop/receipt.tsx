'use client'
// The shop's receipt: order number, items, amount, method, time, "Print".
import { Printer } from 'lucide-react'
import { formatUsd, type Receipt } from '@zecca/contracts'
import { SERIF, ShopButton } from './shop-frame'

export function ShopReceipt({ receipt }: { receipt: Receipt }) {
  const when = new Date(receipt.at)
  return (
    <article className="rounded-[6px] border border-[var(--s-line)] bg-[var(--s-card)] p-6 sm:p-8" aria-label={`Receipt ${receipt.orderNumber}`}>
      <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-dashed border-[var(--s-line)] pb-4">
        <p className="text-[22px] italic" style={{ fontFamily: SERIF }}>
          {receipt.shopName}
        </p>
        <p className="tabular text-[14px] text-[var(--s-muted)]">Order {receipt.orderNumber}</p>
      </header>
      <ul className="divide-y divide-[var(--s-line)]">
        {receipt.items.map((l) => (
          <li key={l.name} className="flex items-baseline justify-between gap-4 py-3 text-[15px]">
            <span>
              <span className="tabular text-[var(--s-muted)]">{l.qty} ×</span> {l.name}
            </span>
            <span className="tabular">{formatUsd(l.qty * l.unitMinor)}</span>
          </li>
        ))}
      </ul>
      <dl className="mt-2 space-y-2 border-t border-[var(--s-ink)]/20 pt-4 text-[15px]">
        <div className="flex justify-between">
          <dt className="font-[650]">Total</dt>
          <dd className="tabular text-[20px]" style={{ fontFamily: SERIF }}>
            {formatUsd(receipt.amountMinor)}
          </dd>
        </div>
        <div className="flex justify-between text-[var(--s-muted)]">
          <dt>Paid with</dt>
          <dd>{receipt.method === 'zecca' ? 'Zecca' : `Card ending ${receipt.cardLast4 ?? '····'}`}</dd>
        </div>
        <div className="flex justify-between text-[var(--s-muted)]">
          <dt>Time</dt>
          <dd className="tabular">
            {when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, {when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
          </dd>
        </div>
      </dl>
      <ShopButton variant="outline" className="mt-6 print:hidden" onClick={() => window.print()}>
        <Printer className="size-4" aria-hidden="true" />
        Print
      </ShopButton>
    </article>
  )
}
