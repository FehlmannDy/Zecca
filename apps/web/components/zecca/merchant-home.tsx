'use client'
// /merchant: signed out, the sign-up with the business switch on (SPEC §4.11). Signed in as a business, a first
// till shell on the glass dashboard with today's real totals; agent G builds the charge and sales screens on it.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Banknote, Hash, Percent, Receipt } from 'lucide-react'
import { formatUsd } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { Amount } from './amount'
import { EmptyState, Skeleton } from './bits'
import { GlassRoot, Metric, Panel } from './glass'
import { SignupGate } from './signup-gate'
import { useHydrated } from './user-shell'
import { Logo } from './wordmark'

export function MerchantHome() {
  const session = useSession()
  const hydrated = useHydrated()
  const [mode, setMode] = useState<'unknown' | 'signup' | 'till'>('unknown')
  useEffect(() => {
    if (!hydrated) return
    setMode((m) => (m === 'unknown' ? (session?.user ? 'till' : 'signup') : m))
  }, [hydrated, session])
  if (mode === 'signup') return <SignupGate business />
  if (mode === 'unknown') return null
  return <Till />
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

function Till() {
  const { api } = useApp()
  const session = useSession()
  const router = useRouter()
  const user = session?.user
  const isMerchant = !!user?.role.includes('merchant')
  const sales = useResource(() => api.call('sales', { query: { from: startOfToday() } }), [api], isMerchant)

  useEffect(() => {
    if (!user) router.replace('/merchant')
  }, [user, router])
  if (!user) return null

  const t = sales.data?.totals
  return (
    <GlassRoot>
      <div className="mx-auto w-full max-w-[1120px] px-4 pb-16 pt-4 lg:px-8">
        <header className="flex h-14 items-center justify-between">
          <Logo />
          <Link href="/app" className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface/70 px-4 text-[13px] font-[650]">
            Personal
          </Link>
        </header>
        {!isMerchant ? (
          <Panel className="mx-auto mt-10 max-w-[520px]" title="This account is personal">
            <p className="text-[15px] text-muted">Business accounts are opened at sign-up, with the business switch on.</p>
          </Panel>
        ) : (
          <main className="pt-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="label-caps text-muted">Till</p>
                <h1 className="mt-2 text-[34px] font-[760] leading-tight tracking-[-0.035em]">{user.merchant?.businessName ?? user.displayName}</h1>
              </div>
              <Link href="/merchant/charge" className="inline-flex min-h-12 items-center rounded-[14px] bg-ink px-6 text-[15px] font-[700] text-paper hover:opacity-90">
                Charge
              </Link>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
              {sales.error && !t ? (
                <p className="col-span-full text-[15px] text-alert" role="alert">
                  {sales.error}
                </p>
              ) : !t ? (
                Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[104px] rounded-[20px]" />)
              ) : (
                <>
                  <Metric tone="in" title="Today" icon={<Banknote />} value={<Amount minor={t.grossMinor} size="lg" className="!text-white" />} caption="Gross sales" />
                  <Metric title="Sales" icon={<Hash />} value={<span className="tabular">{t.count}</span>} caption="Paid today" />
                  <Metric title="Average" icon={<Receipt />} value={<Amount minor={t.count ? Math.round(t.grossMinor / t.count) : 0} size="lg" />} caption="Per sale" />
                  <Metric title="Fees" icon={<Percent />} value={<Amount minor={t.feeMinor} size="lg" />} caption={`${(user.merchant?.feeBps ?? 50) / 100}% per sale. No monthly fee.`} />
                </>
              )}
            </div>
            <Panel className="mt-4" title="Today's sales">
              {!sales.data ? (
                <Skeleton className="h-24 w-full" />
              ) : sales.data.items.length === 0 ? (
                <EmptyState title="No sales yet today. Tap Charge to take your first payment." />
              ) : (
                <ul className="divide-y divide-line">
                  {sales.data.items.map((s) => (
                    <li key={s.id} className="flex min-h-14 items-center justify-between gap-3 text-[15px]">
                      <span>
                        <span className="font-[650]">{s.payer?.displayName.split(' ')[0] ?? 'Customer'}</span>
                        <span className="ml-2 text-muted">{new Date(s.paidAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-[13px] text-muted">{s.payoutStatus === 'done' ? 'Paid out' : 'Paying out'}</span>
                        <span className="tabular font-[680]">{formatUsd(s.amountMinor)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </main>
        )}
      </div>
    </GlassRoot>
  )
}
