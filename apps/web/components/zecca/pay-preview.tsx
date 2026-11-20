'use client'
// Minimal pay page: merchant, amount, reference, status, shown at once and logged out. Agent G replaces the
// approve part (UI.md §5.5).
import Link from 'next/link'
import { useApp } from '@/lib/app'
import { useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { Amount } from './amount'
import { Avatar, Skeleton } from './bits'
import { GlassBackdrop } from './glass'
import { Logo } from './wordmark'

export function PayRequestPreview({ id }: { id: string }) {
  const { api } = useApp()
  const session = useSession()
  const req = useResource(() => api.call('paymentRequestGet', { params: { id } }), [api, id])
  const pr = req.data
  return (
    <div className="relative min-h-svh">
      <GlassBackdrop />
      <div className="mx-auto flex min-h-svh max-w-[440px] flex-col px-5 py-6">
        <Logo />
        <main className="flex flex-1 flex-col items-center justify-center text-center">
          {req.error ? (
            <p className="text-[16px] text-ink" role="alert">
              {req.error}
            </p>
          ) : !pr ? (
            <div className="flex flex-col items-center gap-4" aria-busy="true">
              <Skeleton className="size-16 rounded-[16px]" />
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-14 w-48" />
            </div>
          ) : (
            <>
              <Avatar name={pr.merchantName} size={64} business />
              <h1 className="mt-4 text-[20px] font-[700]">{pr.merchantName}</h1>
              <Amount minor={pr.amountMinor} size="hero" className="mt-3" />
              {pr.reference && <p className="mt-2 text-[15px] text-muted">{pr.reference}</p>}
              <p className="mt-8 text-[15px] text-muted">
                {pr.status === 'paid'
                  ? 'Paid.'
                  : pr.status === 'expired'
                    ? 'This request has expired. Ask the merchant for a new one.'
                    : pr.status === 'cancelled'
                      ? 'The merchant cancelled this request.'
                      : session?.user
                        ? 'Paying from this page opens soon.'
                        : null}
              </p>
              {!session?.user && (pr.status === 'created' || pr.status === 'opened') && (
                <Link href="/app/signup" className="mt-2 inline-flex min-h-12 w-full items-center justify-center rounded-[14px] bg-ink px-5 text-[15px] font-[680] text-paper">
                  Sign in to pay
                </Link>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}
