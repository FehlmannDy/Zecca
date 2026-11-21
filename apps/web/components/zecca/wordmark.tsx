// The Zecca logo, redrawn as line art from public/brand/zecca-logo.png (1280 x 1280 artboard), plus the text wordmark.
import { cn } from '@/lib/cn'

const ARCHES = Array.from({ length: 7 }, (_, i) => 205 + i * 131)

/** Dome, pediment and arches: the mint, without the letters. Single weight, round caps, nothing filled. */
export function LogoMark({ className, title = 'Zecca' }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="170 80 945 1080"
      className={cn('h-8 w-auto', className)}
      fill="none"
      stroke="currentColor"
      strokeWidth="26"
      strokeLinecap="round"
      strokeLinejoin="round"
      // title="" is decoration next to a name: hidden from screen readers rather than an unnamed image.
      {...(title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}
    >
      <path d="M643 103 V 128" />
      <path d="M593 185 A 50 50 0 0 1 693 185" />
      <path d="M578 185 H 708" />
      <path d="M596 185 V 250 H 690 V 185" />
      <path d="M592 255 L 197 384 M 694 255 L 1089 384" />
      <path d="M197 410 H 1089 M 197 467 H 1089" />
      <path d="M197 845 H 1083 M 197 902 H 1083" />
      {ARCHES.map((x) => (
        <path key={x} d={`M ${x} 1138 V 995 A 45 45 0 0 1 ${x + 90} 995 V 1138`} />
      ))}
    </svg>
  )
}

/** "ZECCA" in Montserrat 500, tracked like the logo. Small sizes only (nav, labels). */
export function Wordmark({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const s = { sm: 'text-[13px]', md: 'text-[16px]', lg: 'text-[24px]' }[size]
  return (
    <span className={cn('font-display font-medium uppercase leading-none tracking-[0.22em]', s, className)} aria-label="Zecca">
      Zecca
    </span>
  )
}

/** Mark and wordmark side by side, for headers. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5 text-ink', className)}>
      <LogoMark className="h-7" title="" />
      <Wordmark />
    </span>
  )
}
