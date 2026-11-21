'use client'
// Bottom sheet (phone) / centred card (wide). Slides up, traps focus, closes on Escape and on the scrim,
// gives focus back to what opened it. `dismissible={false}` while a signature is in flight. `focusKey`: when the content
// changes step (review, working, success), focus moves to its [data-autofocus] instead of falling to <body>.
// Taller than the screen (a phone in landscape): the panel scrolls inside, so the title and Close stay reachable.
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Sheet({
  open,
  onClose,
  title,
  hideTitle = false,
  dismissible = true,
  children,
  className,
  focusKey,
}: {
  open: boolean
  onClose: () => void
  title: string
  hideTitle?: boolean
  dismissible?: boolean
  children: ReactNode
  className?: string
  focusKey?: string
}) {
  const panel = useRef<HTMLDivElement>(null)
  const opener = useRef<Element | null>(null)
  const titleId = useId()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  // Latest handlers without re-running the open effect (which would steal focus on every render).
  const live = useRef({ onClose, dismissible })
  live.current = { onClose, dismissible }

  useEffect(() => {
    if (!open || !mounted) return
    opener.current = document.activeElement
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const first = panel.current?.querySelector<HTMLElement>('[data-autofocus]') ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? panel.current)?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && live.current.dismissible) {
        e.stopPropagation()
        live.current.onClose()
      }
      if (e.key !== 'Tab' || !panel.current) return
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
      if (items.length === 0) {
        e.preventDefault()
        return
      }
      const [a, b] = [items[0], items[items.length - 1]]
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault()
        b.focus()
      } else if (!e.shiftKey && document.activeElement === b) {
        e.preventDefault()
        a.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prevOverflow
      ;(opener.current as HTMLElement | null)?.focus?.()
    }
  }, [open, mounted])

  // A new step: focus its [data-autofocus] (or the first control, or the panel) unless focus is already on a control in it.
  useEffect(() => {
    const p = panel.current
    if (!open || !mounted || focusKey === undefined || !p) return
    const a = document.activeElement
    if (a && a !== p && p.contains(a)) return
    const first = p.querySelector<HTMLElement>('[data-autofocus]') ?? p.querySelector<HTMLElement>(FOCUSABLE)
    ;(first ?? p).focus()
  }, [focusKey, open, mounted])

  if (!mounted || !open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-[var(--scrim)] motion-safe:animate-[z-fade-in_200ms_ease-out]" onClick={() => dismissible && onClose()} aria-hidden="true" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cn(
          'relative max-h-[calc(100dvh-8px)] w-full max-w-[480px] overflow-x-hidden overflow-y-auto overscroll-contain rounded-t-[24px] bg-surface px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3 text-ink shadow-[var(--shadow-float)] outline-none md:rounded-[24px] md:pb-6',
          'motion-safe:animate-[z-sheet-in_260ms_cubic-bezier(0.22,0.8,0.3,1)]',
          className,
        )}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line md:hidden" aria-hidden="true" />
        <div className={cn('mb-4 flex items-center justify-between gap-3', hideTitle && 'sr-only')}>
          <h2 id={titleId} className="text-[19px] font-[740] tracking-[-0.02em]">
            {title}
          </h2>
          {dismissible && (
            <button type="button" onClick={onClose} className="-mr-2 grid size-11 shrink-0 place-items-center rounded-full text-muted hover:bg-paper hover:text-ink" aria-label="Close">
              <X className="size-5" aria-hidden="true" />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
