// "How a payment works" (UI §5.1): you -> Zecca pool -> merchant in line art, with what an outside observer sees under
// each arrow. One DOM in reading order: a column on a phone, a row of five cells on wide screens.
import Link from 'next/link'
import { Eye } from 'lucide-react'
import { LogoMark } from '@/components/zecca/wordmark'
import { cn } from '@/lib/cn'
import { PAYMENT } from './content'
import { SealedBlock } from './parts'

const LINE = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function PhoneArt() {
  return (
    <svg viewBox="0 0 64 64" className="size-12" aria-hidden="true" {...LINE}>
      <rect x="19" y="5" width="26" height="54" rx="6" />
      <path d="M29 11 H35" />
      <circle cx="32" cy="32" r="8" />
      <path d="M28.5 32.2 L31 34.6 L35.6 29.6" />
      <path d="M28 52 H36" />
    </svg>
  )
}

function ShopArt() {
  return (
    <svg viewBox="0 0 64 64" className="size-12" aria-hidden="true" {...LINE}>
      <path d="M10 22 L15 9 H49 L54 22" />
      <path d="M10 22 A5.5 5 0 0 0 21 22 A5.5 5 0 0 0 32 22 A5.5 5 0 0 0 43 22 A5.5 5 0 0 0 54 22" />
      <path d="M14 28 V55 H50 V28" />
      <path d="M27 55 V40 H37 V55" />
      <path d="M41 35 H46 V42 H41 Z" />
    </svg>
  )
}

const ART = { you: <PhoneArt />, pool: <LogoMark className="h-12" title="" />, merchant: <ShopArt /> } as const

/** A sealed parcel travelling along the arrow: horizontal on wide screens, vertical on a phone. */
function Arrow({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center text-muted', className)} aria-hidden="true">
      <div className="hidden w-full items-center gap-2 px-1 lg:flex">
        <span className="flex-1 border-t-2 border-dotted border-current opacity-60" />
        <svg viewBox="0 0 32 20" className="h-5 w-8 shrink-0" {...LINE} strokeWidth={1.6}>
          <rect x="2" y="2" width="28" height="16" rx="4" stroke="var(--sealed)" />
          <path d="M9 10 H23" stroke="var(--sealed)" />
        </svg>
        <span className="flex-1 border-t-2 border-dotted border-current opacity-60" />
        <svg viewBox="0 0 10 16" className="-ml-2.5 h-4 w-2.5 shrink-0" {...LINE} strokeWidth={1.6}>
          <path d="M2 2 L8 8 L2 14" />
        </svg>
      </div>
      <svg viewBox="0 0 28 72" className="h-16 w-7 lg:hidden" {...LINE} strokeWidth={1.6}>
        <path d="M14 4 V64" strokeDasharray="1 6" />
        <path d="M8 58 L14 65 L20 58" />
        <rect x="6" y="22" width="16" height="24" rx="4" stroke="var(--sealed)" fill="var(--paper)" />
        <path d="M14 28 V40" stroke="var(--sealed)" />
      </svg>
    </div>
  )
}

function Node({ id, label, caption, className }: { id: keyof typeof ART; label: string; caption: string; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center text-center', className)}>
      <span className="grid size-24 place-items-center rounded-full border border-line bg-surface text-ink">{ART[id]}</span>
      <p className="mt-3 text-[16px] font-[700] text-ink">{label}</p>
      <p className="text-[13.5px] text-muted">{caption}</p>
    </div>
  )
}

function Hop({ hop, className }: { hop: (typeof PAYMENT.hops)[number]; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[400px] rounded-[20px] border border-line bg-surface p-5', className)}>
      <p className="flex items-baseline gap-2.5">
        <span className="label-caps text-muted">Step {hop.step}</span>
        <span className="text-[16px] font-[700] text-ink">{hop.title}</span>
      </p>
      <p className="mt-2 text-[14.5px] leading-[1.55] text-muted">{hop.body}</p>
      <div className="mt-4 rounded-[14px] border border-dashed p-3.5" style={{ borderColor: 'color-mix(in srgb, var(--sealed) 35%, var(--line))' }}>
        <p className="label-caps flex items-center gap-1.5 text-sealed">
          <Eye className="size-3.5" strokeWidth={2} aria-hidden="true" />
          What an observer sees
        </p>
        <ul className="mt-2.5 space-y-2 text-[14px]">
          <li className="text-ink">{hop.observer.addresses}</li>
          <li className="flex flex-wrap items-center gap-2 text-ink">
            <span>Amount</span>
            <SealedBlock label={hop.observer.amount} />
          </li>
        </ul>
      </div>
    </div>
  )
}

export function PoolDiagram() {
  const [you, pool, merchant] = PAYMENT.nodes
  const [first, second] = PAYMENT.hops
  return (
    <div>
      <div className="flex flex-col items-stretch gap-3 lg:grid lg:grid-cols-[auto_1fr_auto_1fr_auto] lg:items-start lg:gap-x-4 lg:gap-y-8">
        <Node {...you} id="you" className="lg:col-start-1 lg:row-start-1" />
        <Arrow className="lg:col-start-2 lg:row-start-1 lg:h-24" />
        <Hop hop={first} className="mb-3 lg:col-start-2 lg:row-start-2 lg:mb-0" />
        <Node {...pool} id="pool" className="lg:col-start-3 lg:row-start-1" />
        <Arrow className="lg:col-start-4 lg:row-start-1 lg:h-24" />
        <Hop hop={second} className="mb-3 lg:col-start-4 lg:row-start-2 lg:mb-0" />
        <Node {...merchant} id="merchant" className="lg:col-start-5 lg:row-start-1" />
      </div>
      <p className="mx-auto mt-12 max-w-[62ch] text-center text-[17px] leading-[1.6] text-ink">{PAYMENT.outcome}</p>
      <p className="mt-3 text-center text-[14px] text-muted">
        {PAYMENT.caveat}{' '}
        <Link href="/how-it-works#limits" className="font-[620] text-ink underline decoration-line underline-offset-4 hover:decoration-ink">
          Read the limits
        </Link>
      </p>
    </div>
  )
}
