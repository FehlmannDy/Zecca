// Money on screen: dollars large, cents smaller and lighter, tabular figures. Integer cents in, text out.
import { amountParts } from '@/lib/money'
import { cn } from '@/lib/cn'

const SIZES = {
  hero: { d: 'text-[56px] leading-[1] tracking-[-0.045em] font-[720]', c: 'text-[28px] tracking-[-0.02em]' },
  xl: { d: 'text-[40px] leading-[1.05] tracking-[-0.04em] font-[720]', c: 'text-[22px]' },
  lg: { d: 'text-[28px] leading-[1.1] tracking-[-0.03em] font-[700]', c: 'text-[17px]' },
  md: { d: 'text-[17px] leading-[1.2] tracking-[-0.01em] font-[680]', c: 'text-[13px]' },
  sm: { d: 'text-[14px] leading-[1.2] font-[650]', c: 'text-[12px]' },
} as const

export function Amount({
  minor,
  size = 'md',
  direction,
  className,
  tone,
}: {
  minor: number
  size?: keyof typeof SIZES
  /** 'in' adds the "+" sign and the --in colour; 'out' is plain ink (spending is not an error). */
  direction?: 'in' | 'out'
  className?: string
  tone?: 'in' | 'ink' | 'muted'
}) {
  const p = amountParts(minor, { direction })
  const s = SIZES[size]
  const color = tone === 'muted' ? 'text-muted' : tone === 'in' || direction === 'in' ? 'text-in' : 'text-ink'
  // Lighter cents on ink only. On a coloured amount (--in, or a forced colour such as white on a green panel) 60% would
  // fall under 4.5:1, so the cents keep the full colour there.
  const dimCents = color === 'text-ink' && !/(^|\s)!text-/.test(className ?? '')
  return (
    <span className={cn('tabular inline-flex items-baseline whitespace-nowrap', color, className)}>
      <span className="sr-only">{p.text}</span>
      <span aria-hidden="true" className={s.d}>
        {p.sign}${p.dollars}
      </span>
      <span aria-hidden="true" className={cn(s.c, 'font-[560]', dimCents && 'opacity-60')}>
        .{p.cents}
      </span>
    </span>
  )
}
