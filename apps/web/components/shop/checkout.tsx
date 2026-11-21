'use client'
// Checkout (UI.md §5.11): the order, then two ways to pay side by side. "Pay with Zecca": a QR code on a laptop, a
// button to the pay page on a phone, "Waiting for your approval" until the request's public stream says paid.
// "Pay by card": an ordinary card form, "Coming soon" until the card feature is on.
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { formatUsd, type PaymentRequest, type Receipt } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { isApiError } from '@/lib/api'
import { useMediaQuery } from '@/lib/use-media'
import { QrCode } from '@/components/merchant/qr-code'
import { mergeRequest } from '@/components/merchant/till-model'
import { useInterval, useRequestStream } from '@/components/merchant/use-request-stream'
import { ShopReceipt } from './receipt'
import { SERIF, ShopButton } from './shop-frame'
import { ShopUnavailable } from './shop-home'
import { useBasket } from './use-basket'
import { useShopResource } from './use-shop-resource'

const field =
  'h-12 w-full rounded-[4px] border border-[var(--s-line)] bg-white px-3 text-[16px] text-[var(--s-ink)] placeholder:text-[var(--s-muted)]/70 disabled:bg-[var(--s-bg)] disabled:text-[var(--s-muted)]'

export function Checkout({ id }: { id: string }) {
  const { api, config } = useApp()
  const router = useRouter()
  const order = useShopResource(() => api.call('shopOrderGet', { params: { id } }), [api, id])
  const [request, setRequest] = useState<PaymentRequest | null>(null)
  const [cardReceipt, setCardReceipt] = useState<Receipt | null>(null)
  const [restartError, setRestartError] = useState('')
  const phone = useMediaQuery('(max-width: 767px)')
  const { clear } = useBasket()

  const o = order.data
  const receipt = cardReceipt ?? (o?.status === 'paid' ? o.receipt : undefined)
  const refresh = order.refresh
  const onRequest = useCallback(
    (r: PaymentRequest) => {
      setRequest((c) => mergeRequest(c, r))
      if (r.status === 'paid') refresh()
    },
    [refresh],
  )
  const ended = request?.status === 'expired' || request?.status === 'cancelled'
  useRequestStream(o?.paymentRequestId && !receipt && !ended ? o.paymentRequestId : null, onRequest, refresh)
  // Paid: the receipt comes with the next read of the order.
  useInterval(refresh, 1500, request?.status === 'paid' && !receipt)
  useEffect(() => {
    if (receipt) clear()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!receipt])

  async function startAgain() {
    if (!o) return
    setRestartError('')
    try {
      const n = await api.call('shopOrderCreate', { body: { items: o.items.map(({ sku, qty }) => ({ sku, qty })) } })
      router.replace(`/demo/shop/checkout/${encodeURIComponent(n.orderId)}`)
    } catch (e) {
      setRestartError(isApiError(e) || e instanceof Error ? e.message : 'Something went wrong. Try again.')
    }
  }

  if (order.error && !o) return <ShopUnavailable trouble={order.trouble} onRetry={order.reload} />
  if (!o) return <div className="h-96 animate-pulse rounded-[6px] bg-[var(--s-line)]/40" aria-busy="true" aria-label="Loading your order" />

  if (receipt) {
    return (
      <div className="mx-auto max-w-[620px]">
        <p className="text-[12px] uppercase tracking-[0.2em] text-[var(--s-olive)] print:hidden">Thank you</p>
        <h1 className="mt-2 text-[40px] leading-tight" style={{ fontFamily: SERIF }} aria-live="polite">
          Order confirmed
        </h1>
        <p className="mt-2 text-[16px] text-[var(--s-muted)] print:hidden">Your coffee would be on its way, if this were a real shop. Your receipt:</p>
        <div className="mt-6">
          <ShopReceipt receipt={receipt} />
        </div>
        <Link href="/demo/shop" className="mt-6 inline-flex min-h-12 items-center text-[15px] font-[600] underline decoration-[var(--s-line)] underline-offset-4 print:hidden">
          Back to the shop
        </Link>
      </div>
    )
  }

  const payUrl = request?.url ?? (config ? `${config.webOrigin}/pay/${o.paymentRequestId}` : null)
  const payHref = payUrl ? `${payUrl}?return=${encodeURIComponent(`/demo/shop/checkout/${id}`)}` : null

  return (
    <div>
      <h1 className="text-[36px]" style={{ fontFamily: SERIF }}>
        Checkout
      </h1>
      <section aria-label="Order summary" className="mt-5 rounded-[6px] border border-[var(--s-line)] bg-[var(--s-card)] p-5">
        <ul className="space-y-1.5 text-[15px]">
          {o.items.map((l) => (
            <li key={l.sku} className="flex justify-between gap-4">
              <span>
                <span className="tabular text-[var(--s-muted)]">{l.qty} ×</span> {l.name}
              </span>
              <span className="tabular">{formatUsd(l.qty * l.unitMinor)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-baseline justify-between border-t border-[var(--s-line)] pt-3">
          <span className="font-[650]">Total</span>
          <span className="tabular text-[24px]" style={{ fontFamily: SERIF }}>
            {formatUsd(o.amountMinor)}
          </span>
        </div>
      </section>

      <div className="mt-6 grid gap-5 md:grid-cols-2">
        <section aria-labelledby="pay-zecca" className="flex flex-col rounded-[6px] border-2 border-[var(--s-ink)] bg-[var(--s-card)] p-6">
          <h2 id="pay-zecca" className="text-[22px]" style={{ fontFamily: SERIF }}>
            Pay with Zecca
          </h2>
          {ended ? (
            <div className="mt-4">
              <p className="text-[16px]" role="status">
                This payment link has expired.
              </p>
              <ShopButton className="mt-4" onClick={startAgain}>
                Start again
              </ShopButton>
              <p className="mt-2 text-[14px] text-[var(--s-accent)]" role="alert">
                {restartError}
              </p>
            </div>
          ) : phone ? (
            <>
              <p className="mt-2 text-[15px] text-[var(--s-muted)]">Approve in the Zecca app. You come back here when it is done.</p>
              {payHref && (
                <a href={payHref} className="mt-5 inline-flex min-h-12 items-center justify-center rounded-[4px] bg-[var(--s-ink)] px-6 text-[15px] font-[650] text-[var(--s-bg)]">
                  Pay {formatUsd(o.amountMinor)} with Zecca
                </a>
              )}
            </>
          ) : (
            <>
              <p className="mt-2 text-[15px] text-[var(--s-muted)]">Scan with your phone&apos;s camera and approve in Zecca.</p>
              {payUrl && <QrCode value={payHref ?? payUrl} label={`Code to pay ${formatUsd(o.amountMinor)} with Zecca`} dark="#2b1a12" light="#ffffff" className="mt-5 w-[220px] self-center border border-[var(--s-line)]" />}
              {payHref && (
                <a href={payHref} className="mt-4 self-center text-[14px] font-[600] underline decoration-[var(--s-line)] underline-offset-4">
                  Or pay in this browser
                </a>
              )}
            </>
          )}
          {!ended && (
            <p className="mt-6 flex items-center gap-2 text-[15px] font-[600]" aria-live="polite">
              <span className="size-2.5 rounded-full bg-[var(--s-accent)] motion-safe:animate-pulse" aria-hidden="true" />
              {request?.status === 'opened' ? 'Waiting for your approval in Zecca' : request?.status === 'paid' ? 'Paid. Preparing your receipt' : 'Waiting for your approval'}
            </p>
          )}
        </section>

        <CardOption orderId={o.id} amountMinor={o.amountMinor} enabled={!!config?.features.card} onApproved={setCardReceipt} />
      </div>
    </div>
  )
}

function CardOption({ orderId, amountMinor, enabled, onApproved }: { orderId: string; amountMinor: number; enabled: boolean; onApproved: (r: Receipt) => void }) {
  const { api } = useApp()
  const [pan, setPan] = useState('')
  const [exp, setExp] = useState('')
  const [cvc, setCvc] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function pay(e: React.FormEvent) {
    e.preventDefault()
    setMessage('')
    const m = /^(\d{1,2})\s*\/\s*(\d{2})$/.exec(exp.trim())
    const digits = pan.replace(/\s+/g, '')
    if (!m || !/^\d{12,19}$/.test(digits) || !/^\d{3,4}$/.test(cvc)) {
      setMessage('Check the card number, expiry (MM/YY) and code.')
      return
    }
    setBusy(true)
    try {
      const r = await api.call('shopCharge', { body: { orderId, pan: digits, expMonth: Number(m[1]), expYear: 2000 + Number(m[2]), cvc } })
      if (r.approved && r.receipt) onApproved(r.receipt)
      else setMessage('Card declined. Try another payment method.')
    } catch (err) {
      setMessage(isApiError(err) ? err.message : 'Card declined. Try another payment method.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="pay-card" className="rounded-[6px] border border-[var(--s-line)] bg-[var(--s-card)] p-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="pay-card" className="text-[22px]" style={{ fontFamily: SERIF }}>
          Pay by card
        </h2>
        {!enabled && <span className="rounded-full bg-[var(--s-line)] px-2.5 py-0.5 text-[12px] font-[650] text-[var(--s-ink)]">Coming soon</span>}
      </div>
      <form className="mt-4 space-y-3" onSubmit={pay} aria-describedby={!enabled ? 'card-soon' : undefined}>
        <fieldset disabled={!enabled || busy} className="space-y-3">
          <label className="block">
            <span className="text-[13px] font-[600] text-[var(--s-muted)]">Card number</span>
            <input className={`${field} mt-1`} inputMode="numeric" autoComplete="cc-number" placeholder="1234 5678 9012 3456" value={pan} onChange={(e) => setPan(e.target.value)} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[13px] font-[600] text-[var(--s-muted)]">Expiry</span>
              <input className={`${field} mt-1`} inputMode="numeric" autoComplete="cc-exp" placeholder="MM/YY" value={exp} onChange={(e) => setExp(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-[13px] font-[600] text-[var(--s-muted)]">Security code</span>
              <input className={`${field} mt-1`} inputMode="numeric" autoComplete="cc-csc" placeholder="123" value={cvc} onChange={(e) => setCvc(e.target.value)} />
            </label>
          </div>
          <ShopButton type="submit" variant="outline" className="w-full">
            {busy ? 'Checking the card…' : `Pay ${formatUsd(amountMinor)}`}
          </ShopButton>
        </fieldset>
        {!enabled && (
          <p id="card-soon" className="text-[14px] text-[var(--s-muted)]">
            Card payments arrive soon. Pay with Zecca for now.
          </p>
        )}
        <p className="min-h-5 text-[14px] font-[600] text-[var(--s-accent)]" role="alert">
          {message}
        </p>
      </form>
    </section>
  )
}
