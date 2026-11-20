'use client'
// Building blocks extracted from components/ui/glassy-dashboard.tsx, with real props and no sample records.
import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import { X, type LucideIcon } from 'lucide-react'
import { gsap } from 'gsap'
import { useReducedMotion } from '@/lib/use-media'
import { cn } from '@/lib/cn'
import { GlassBackdrop } from './backdrop'
import { glassStyles } from './styles'

/** Root of any glass screen: the gd-* style layer, Zecca's backdrop, and the frost amount (0-36 px). */
export function GlassRoot({ children, frost = 12, className, backdrop = true }: { children: ReactNode; frost?: number; className?: string; backdrop?: boolean }) {
  return (
    <div className={cn('gd-app', className)} style={{ '--gd-panel-frost': `${Math.max(0, Math.min(36, frost))}px` } as CSSProperties}>
      <style>{glassStyles}</style>
      {backdrop && <GlassBackdrop />}
      {children}
    </div>
  )
}

export function Panel({ title, subtitle, action, className, children, as: Tag = 'section', ...rest }: {
  title?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  className?: string
  children?: ReactNode
  as?: 'section' | 'div' | 'article'
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  return (
    <Tag className={cn('gd-panel', className)} {...rest}>
      {(title || action) && (
        <header className="gd-panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p>{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </Tag>
  )
}

export function Metric({ title, icon, value, caption, delta, tone, className }: {
  title: ReactNode
  icon?: ReactNode
  value: ReactNode
  caption?: ReactNode
  delta?: { text: string; attention?: boolean; icon?: ReactNode }
  tone?: 'in'
  className?: string
}) {
  return (
    <article className={cn('gd-metric', className)} data-tone={tone}>
      <div className="gd-metric-head">
        <span>{title}</span>
        {icon && <span className="gd-metric-icon" aria-hidden="true">{icon}</span>}
      </div>
      <strong className="gd-metric-value">{value}</strong>
      {(caption || delta) && (
        <div className="gd-metric-caption">
          {delta && (
            <span className="gd-delta" data-attention={delta.attention ? 'true' : undefined}>
              {delta.icon}
              {delta.text}
            </span>
          )}
          {caption && <span>{caption}</span>}
        </div>
      )}
    </article>
  )
}

/** Status pill. The word carries the meaning; the colour only repeats it. */
export function Badge({ tone = 'ink', children }: { tone?: 'ink' | 'in' | 'alert' | 'sealed' | 'brass'; children: ReactNode }) {
  return (
    <span className="gd-status" data-state={tone}>
      <i aria-hidden="true" />
      {children}
    </span>
  )
}

/** A number that counts to its value (GSAP), instantly under reduced motion. Screen readers get the final text. */
export function Counter({ value, format }: { value: number; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const from = useRef(0)
  const reduced = useReducedMotion()
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduced) {
      el.textContent = format(value)
      from.current = value
      return
    }
    const box = { v: from.current }
    const tween = gsap.to(box, {
      v: value,
      duration: 0.75,
      ease: 'power3.out',
      onUpdate: () => {
        el.textContent = format(Math.round(box.v))
      },
      onComplete: () => {
        from.current = value
      },
    })
    return () => {
      tween.kill()
      from.current = value
    }
  }, [value, reduced, format])
  return (
    <>
      <span ref={ref} aria-hidden="true">
        {format(value)}
      </span>
      <span className="gd-sr">{format(value)}</span>
    </>
  )
}

export type DockItem = { href: string; label: string; icon: LucideIcon; current?: boolean }

/** The glass dock: a pill that slides to the current item. `side` stacks it vertically with tooltips. */
export function Dock({ items, side = false, label, className }: { items: DockItem[]; side?: boolean; label: string; className?: string }) {
  const nav = useRef<HTMLElement>(null)
  const marker = useRef<HTMLSpanElement>(null)
  const currentHref = items.find((i) => i.current)?.href
  useEffect(() => {
    const container = nav.current
    const indicator = marker.current
    if (!container || !indicator) return
    const adjust = () => {
      const current = container.querySelector<HTMLElement>('[aria-current="page"]')
      if (!current) {
        indicator.dataset.ready = 'false'
        indicator.style.visibility = 'hidden'
        return
      }
      indicator.style.visibility = ''
      indicator.style.width = `${current.offsetWidth}px`
      indicator.style.height = `${current.offsetHeight}px`
      indicator.style.transform = `translate(${current.offsetLeft}px, ${current.offsetTop}px)`
      indicator.dataset.ready = 'true'
    }
    const observer = new ResizeObserver(adjust)
    observer.observe(container)
    container.querySelectorAll('a').forEach((a) => observer.observe(a))
    adjust()
    return () => observer.disconnect()
  }, [currentHref, items.length])
  return (
    <nav ref={nav} className={cn('gd-dock', side ? 'gd-dock-side' : 'gd-dock-bottom', className)} aria-label={label}>
      <span ref={marker} className="gd-dock-indicator" aria-hidden="true" />
      {items.map(({ href, label: text, icon: Icon, current }) => (
        <Link key={href} href={href} aria-current={current ? 'page' : undefined} aria-label={side ? text : undefined}>
          <Icon aria-hidden="true" />
          <span className="gd-dock-text">{text}</span>
          {side && (
            <span className="gd-dock-tip" aria-hidden="true">
              {text}
            </span>
          )}
        </Link>
      ))}
    </nav>
  )
}

/** Native modal dialog in the glass style (focus is trapped by the browser; Escape closes). */
export function Dialog({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const labelId = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="gd-dialog"
      aria-labelledby={labelId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close()
      }}
    >
      {open && (
        <section className="gd-dialog-inner">
          <header>
            <h2 id={labelId}>{title}</h2>
            <button type="button" className="gd-icon-button" aria-label="Close" onClick={() => ref.current?.close()}>
              <X aria-hidden="true" />
            </button>
          </header>
          {children}
        </section>
      )}
    </dialog>
  )
}
