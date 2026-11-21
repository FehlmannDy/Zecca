'use client'
// The merchant space (SPEC §4.11, UI.md §4): signed out, the normal sign-up with "I'm setting up a business" on.
// Signed in as a business: the till on a phone, the glass sales dashboard on a tablet or laptop.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Calculator, ChartColumn, Smartphone, UserRound } from 'lucide-react'
import { useSession } from '@/lib/session'
import { nextSpaceMode, type SpaceMode } from '@/lib/space-mode'
import { useWide } from '@/lib/use-media'
import { Dock, GlassRoot, Panel, type DockItem } from '@/components/zecca/glass'
import { SignupGate } from '@/components/zecca/signup-gate'
import { useHydrated } from '@/components/zecca/user-shell'
import { Logo } from '@/components/zecca/wordmark'
import { Sales } from './sales'
import { Till } from './till'

export type MerchantView = 'home' | 'charge' | 'sales'

export function MerchantSpace({ view }: { view: MerchantView }) {
  const session = useSession()
  const hydrated = useHydrated()
  const router = useRouter()
  const [mode, setMode] = useState<SpaceMode>('unknown')
  useEffect(() => {
    setMode((m) => nextSpaceMode(m, hydrated, !!session?.user))
  }, [hydrated, session])
  // Signed out on a sub-page: sign up from /merchant.
  useEffect(() => {
    if (mode === 'signup' && view !== 'home') router.replace('/merchant')
  }, [mode, view, router])
  if (mode === 'signup') return view === 'home' ? <SignupGate business onFinished={() => setMode('space')} /> : null
  if (mode === 'unknown') return null
  return <Space view={view} />
}

function Space({ view }: { view: MerchantView }) {
  const session = useSession()
  const router = useRouter()
  const wide = useWide()
  const user = session?.user
  useEffect(() => {
    if (!user) router.replace('/merchant')
  }, [user, router])
  if (!user) return null

  const isMerchant = user.role.includes('merchant')
  const shown: 'charge' | 'sales' = view === 'home' ? (wide ? 'sales' : 'charge') : view
  const items: DockItem[] = [
    { href: '/merchant/charge', label: 'Charge', icon: Calculator, current: shown === 'charge' },
    { href: '/merchant/sales', label: 'Sales', icon: ChartColumn, current: shown === 'sales' },
    { href: '/merchant/pair', label: 'Tills', icon: Smartphone },
    { href: '/app', label: 'Personal', icon: UserRound },
  ]
  const name = user.merchant?.businessName ?? user.displayName

  return (
    <GlassRoot>
      <div className="mx-auto w-full max-w-[1120px] px-4 pb-32 pt-[max(16px,env(safe-area-inset-top))] lg:px-8 lg:pb-12">
        <header className="flex h-14 items-center justify-between gap-3">
          <Link href="/merchant" aria-label="Business home" className="rounded-[10px]">
            <Logo />
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden text-right sm:block">
              <span className="block text-[14px] font-[650] leading-tight">{name}</span>
              <span className="block text-[12.5px] text-muted">@{user.handle}</span>
            </span>
            {wide && isMerchant && (
              <nav aria-label="Business" className="ml-3 flex items-center gap-2">
                <Link href="/merchant/sales" aria-current={shown === 'sales' ? 'page' : undefined} className="inline-flex min-h-11 items-center rounded-full px-4 text-[13.5px] font-[650] text-muted hover:text-ink aria-[current=page]:text-ink">
                  Sales
                </Link>
                <Link href="/merchant/pair" className="inline-flex min-h-11 items-center rounded-full px-4 text-[13.5px] font-[650] text-muted hover:text-ink">
                  Pair a till
                </Link>
                <Link href="/merchant/charge" className="inline-flex min-h-11 items-center rounded-[14px] bg-ink px-5 text-[14px] font-[700] text-paper hover:opacity-90">
                  Charge
                </Link>
                <Link href="/app" className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface/70 px-4 text-[13px] font-[650]">
                  Personal
                </Link>
              </nav>
            )}
          </div>
        </header>
        {!isMerchant ? (
          <Panel className="mx-auto mt-10 max-w-[520px]" title="This account is personal">
            <p className="text-[15px] text-muted">Business accounts are opened at sign-up, with the business switch on.</p>
            <Link href="/app" className="mt-5 inline-flex min-h-12 items-center rounded-[14px] bg-ink px-5 text-[15px] font-[680] text-paper">
              Go to home
            </Link>
          </Panel>
        ) : (
          <main className="pt-4">
            <div className="mb-5">
              <p className="label-caps text-muted">{shown === 'charge' ? 'Till' : 'Sales'}</p>
              <h1 className="mt-2 text-[28px] font-[760] leading-tight tracking-[-0.035em] lg:text-[34px]">{name}</h1>
            </div>
            {shown === 'charge' ? (
              wide ? (
                // On a wide screen the keypad sits on a frosted panel, so the backdrop's lines do not cross the keys.
                <Panel as="div" className="mx-auto max-w-[480px]" style={{ padding: 32 }}>
                  <Till />
                </Panel>
              ) : (
                <Till className="pt-2" />
              )
            ) : (
              <Sales wide={wide} />
            )}
          </main>
        )}
      </div>
      {isMerchant && !wide && (
        <div className="lg:hidden">
          <Dock items={items} label="Business" />
        </div>
      )}
    </GlassRoot>
  )
}

