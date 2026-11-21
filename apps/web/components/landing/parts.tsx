// Small pieces shared by the landing page and /how-it-works. Line icons only: lucide at one weight, round caps.
import Link from 'next/link'
import type { ReactNode } from 'react'
import { BadgeCheck, HandCoins, Layers, Lock, type LucideIcon } from 'lucide-react'
import { Arches } from '@/components/zecca/arches'
import { cn } from '@/lib/cn'
import type { BlockIcon } from './content'

export const ICON_STROKE = 1.5

export const BLOCK_ICONS: Record<BlockIcon, LucideIcon> = { sponsor: HandCoins, sealed: Lock, batch: Layers, credential: BadgeCheck }

/** A line icon in a hairline circle. */
export function IconBadge({ icon: Icon, className }: { icon: LucideIcon; className?: string }) {
  return (
    <span className={cn('grid size-11 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink', className)} aria-hidden="true">
      <Icon className="size-5" strokeWidth={ICON_STROKE} />
    </span>
  )
}

/** A link that looks like the app's Button (components/zecca/bits): 48 px tall, 14 px radius. */
export function LinkButton({ href, variant = 'primary', className, children }: { href: string; variant?: 'primary' | 'secondary'; className?: string; children: ReactNode }) {
  const v = variant === 'primary' ? 'bg-ink text-paper hover:opacity-90' : 'border border-line bg-surface text-ink hover:border-ink/30'
  return (
    <Link href={href} className={cn('inline-flex min-h-12 items-center justify-center gap-2 rounded-[14px] px-5 text-[15px] font-[680] transition-[opacity,border-color] duration-150', v, className)}>
      {children}
    </Link>
  )
}

export function Section({ id, label, title, intro, children, className }: { id?: string; label?: string; title: string; intro?: ReactNode; children: ReactNode; className?: string }) {
  const headingId = id ? `${id}-title` : undefined
  return (
    <section id={id} aria-labelledby={headingId} className={cn('mx-auto w-full max-w-[1120px] px-4 py-16 sm:px-6 md:py-24', className)}>
      {label && <p className="label-caps mb-3 text-muted">{label}</p>}
      <h2 id={headingId} className="max-w-[24ch] text-[30px] font-[720] leading-[1.1] tracking-[-0.03em] text-ink md:text-[40px]">
        {title}
      </h2>
      {intro && <p className="mt-4 max-w-[60ch] text-pretty text-[16px] leading-[1.6] text-muted md:text-[17px]">{intro}</p>}
      <div className="mt-10 md:mt-12">{children}</div>
    </section>
  )
}

/** Where something runs, as a small hairline pill. */
export function NetworkChip({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-[12px] border border-line px-2.5 py-1 text-[12.5px] font-[600] leading-tight text-muted', className)}>{children}</span>
}

/** Hidden data, drawn as a sealed block in --sealed. An illustration: it never pretends to be real ciphertext. */
export function SealedBlock({ className, label = 'Sealed' }: { className?: string; label?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 rounded-[8px] px-2 py-1 text-[12.5px] font-[650] text-sealed', className)} style={{ background: 'color-mix(in srgb, var(--sealed) 10%, transparent)' }}>
      <Lock className="size-3.5" strokeWidth={2} aria-hidden="true" />
      <span aria-hidden="true" className="flex gap-[3px]">
        {[14, 8, 18, 10, 12].map((w, i) => (
          <span key={i} className="h-[7px] rounded-full bg-sealed" style={{ width: w, opacity: 0.35 + (i % 3) * 0.2 }} />
        ))}
      </span>
      <span>{label}</span>
    </span>
  )
}

/** The arches as the section divider (UI §1). */
export function Divider() {
  return (
    <div className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
      <Arches variant="divider" />
    </div>
  )
}
