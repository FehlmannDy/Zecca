'use client'
// "Pay by card" for the demo shop's checkout (SPEC §4.14, UI.md §5.11): an ordinary card form (number, expiry, code).
// It calls POST /v1/demo/shop/charge; approved -> onResult with the receipt ("Order confirmed"); declined ->
// "Card declined. Try another payment method." Styled with the shop's own variables (--s-*), with plain fallbacks.
import { useId, useState } from 'react'
import { formatUsd, type Receipt } from '@zecca/contracts'
import { isApiError } from '@/lib/api'
import { useApi } from '@/lib/app'
import { cn } from '@/lib/cn'
import { cardFormErrors, formatCardNumberInput, formatExpiryInput, parseExpiry, type CardForm } from './card-logic'

export type CardPaymentResult = { approved: true; receipt: Receipt } | { approved: false; message: string }

export const DECLINED = 'Card declined. Try another payment method.'

const input =
  'mt-1 block min-h-12 w-full rounded-[6px] border border-[var(--s-line,#d9cfbf)] bg-[var(--s-field,#fff)] px-3 text-[16px] text-[var(--s-ink,#2b2118)] outline-none placeholder:text-[var(--s-muted,#8a7d6b)] focus-visible:border-[var(--s-ink,#2b2118)] focus-visible:ring-2 focus-visible:ring-[var(--s-accent,#9c4a1a)]/30 aria-[invalid=true]:border-[var(--s-accent,#9c4a1a)]'

export function CardPaymentForm({
  orderId,
  amountMinor,
  onResult,
  disabled = false,
  className,
}: {
  orderId: string
  amountMinor: number
  onResult: (r: CardPaymentResult) => void
  disabled?: boolean
  className?: string
}) {
  const api = useApi()
  const id = useId()
  const [f, setF] = useState<CardForm>({ number: '', expiry: '', cvc: '' })
  const [errors, setErrors] = useState<Partial<Record<keyof CardForm, string>>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  async function pay(e: React.FormEvent) {
    e.preventDefault()
    setMessage('')
    const errs = cardFormErrors(f)
    setErrors(errs)
    if (Object.keys(errs).length) return
    const x = parseExpiry(f.expiry)!
    setBusy(true)
    try {
      const r = await api.call('shopCharge', { body: { orderId, pan: f.number.replace(/\D/g, ''), expMonth: x.expMonth, expYear: x.expYear, cvc: f.cvc.trim() } })
      if (r.approved && r.receipt) {
        setReceipt(r.receipt)
        onResult({ approved: true, receipt: r.receipt })
      } else {
        setMessage(DECLINED)
        onResult({ approved: false, message: DECLINED })
      }
    } catch (err) {
      const m = isApiError(err) && err.status !== 500 ? err.message : DECLINED
      setMessage(m)
      onResult({ approved: false, message: m })
    } finally {
      setBusy(false)
    }
  }

  if (receipt)
    return (
      <div className={cn('text-[var(--s-ink,#2b2118)]', className)} role="status">
        <p className="text-[20px] font-[650]">Order confirmed</p>
        <p className="mt-1 text-[15px] text-[var(--s-muted,#8a7d6b)]">
          Order {receipt.orderNumber} · Card ending {receipt.cardLast4} · {formatUsd(receipt.amountMinor)}
        </p>
      </div>
    )

  const field = (k: keyof CardForm) => ({ 'aria-invalid': !!errors[k], 'aria-describedby': errors[k] ? `${id}-${k}-err` : undefined })
  const err = (k: keyof CardForm) =>
    errors[k] ? (
      <span id={`${id}-${k}-err`} className="mt-1 block text-[13px] font-[600] text-[var(--s-accent,#9c4a1a)]">
        {errors[k]}
      </span>
    ) : null

  return (
    <form className={cn('space-y-3 text-[var(--s-ink,#2b2118)]', className)} onSubmit={pay} noValidate>
      <fieldset disabled={disabled || busy} className="space-y-3">
        <label className="block">
          <span className="text-[13px] font-[600] text-[var(--s-muted,#8a7d6b)]">Card number</span>
          <input
            className={input}
            inputMode="numeric"
            autoComplete="cc-number"
            placeholder="1234 5678 9012 3456"
            value={f.number}
            onChange={(e) => setF({ ...f, number: formatCardNumberInput(e.target.value) })}
            {...field('number')}
          />
          {err('number')}
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-[13px] font-[600] text-[var(--s-muted,#8a7d6b)]">Expiry</span>
            <input className={input} inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" value={f.expiry} onChange={(e) => setF({ ...f, expiry: formatExpiryInput(e.target.value) })} {...field('expiry')} />
            {err('expiry')}
          </label>
          <label className="block">
            <span className="text-[13px] font-[600] text-[var(--s-muted,#8a7d6b)]">Security code</span>
            <input
              className={input}
              inputMode="numeric"
              autoComplete="cc-csc"
              placeholder="123"
              maxLength={4}
              value={f.cvc}
              onChange={(e) => setF({ ...f, cvc: e.target.value.replace(/\D/g, '').slice(0, 4) })}
              {...field('cvc')}
            />
            {err('cvc')}
          </label>
        </div>
        <button
          type="submit"
          className="inline-flex min-h-12 w-full items-center justify-center rounded-[6px] border-2 border-[var(--s-ink,#2b2118)] px-5 text-[15px] font-[650] hover:bg-[var(--s-ink,#2b2118)] hover:text-[var(--s-card,#fffaf2)] disabled:opacity-50"
        >
          {busy ? 'Checking the card…' : `Pay ${formatUsd(amountMinor)}`}
        </button>
      </fieldset>
      <p className="min-h-5 text-[14px] font-[600] text-[var(--s-accent,#9c4a1a)]" role="alert">
        {message}
      </p>
    </form>
  )
}
