'use client'
// Small Zecca pieces: Avatar, HashChip, Skeleton, EmptyState.
import { useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Arches } from './arches'

export function initials(name: string): string {
  const words = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = Array.from(words[0])[0] ?? ''
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? '' : ''
  return (first + last).toUpperCase()
}

/** Initials in a hairline circle. Businesses get a rounded square. */
export function Avatar({ name, size = 40, business = false, className }: { name: string; size?: number; business?: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-grid shrink-0 place-items-center border border-line bg-surface font-[680] text-ink', business ? 'rounded-[12px]' : 'rounded-full', className)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36), letterSpacing: '0.02em' }}
    >
      {initials(name)}
    </span>
  )
}

export function truncateMiddle(s: string, head = 8, tail = 4): string {
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`
}

/** A hash or address in monospace, truncated in the middle, with a copy button. */
export function HashChip({ value, href, label = 'Copy', className }: { value: string; href?: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked: the full value is in the title */
    }
  }
  const text = truncateMiddle(value)
  return (
    <span className={cn('inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-3 pr-1 font-mono text-[12.5px] text-ink', className)} title={value}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2 hover:decoration-ink">
          {text}
        </a>
      ) : (
        <span>{text}</span>
      )}
      <button type="button" onClick={copy} className="grid size-9 place-items-center rounded-full text-muted hover:bg-paper hover:text-ink" aria-label={`${label} ${value}`}>
        {copied ? <Check className="size-4 text-in" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </span>
  )
}

/** Loading placeholder in --line. Never a spinner on a blank page. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <span
      aria-hidden="true"
      className={cn('block rounded-[10px] bg-line motion-safe:animate-[z-shimmer_1.6s_linear_infinite]', className)}
      style={{ backgroundImage: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--surface) 45%, transparent) 50%, transparent 100%)', backgroundSize: '200% 100%', ...style }}
    />
  )
}

/** Empty state: the arches, one line of copy, and what to do next. */
export function EmptyState({ title, action, className }: { title: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-4 px-4 py-10 text-center', className)}>
      <Arches />
      <p className="max-w-[28ch] text-[15px] text-muted">{title}</p>
      {action}
    </div>
  )
}

/** Buttons used across the app: 44 px targets, 14 px radius, visible focus from the base layer. */
export function Button({
  variant = 'primary',
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  const v = {
    primary: 'bg-ink text-paper hover:opacity-90 disabled:opacity-40',
    secondary: 'border border-line bg-surface text-ink hover:border-ink/30 disabled:opacity-50',
    ghost: 'text-ink hover:bg-ink/5 disabled:opacity-50',
    danger: 'border border-alert/40 bg-surface text-alert hover:bg-alert/5',
  }[variant]
  return <button type="button" className={cn('inline-flex min-h-12 items-center justify-center gap-2 rounded-[14px] px-5 text-[15px] font-[680] transition-[opacity,background-color,border-color] duration-150', v, className)} {...rest} />
}
