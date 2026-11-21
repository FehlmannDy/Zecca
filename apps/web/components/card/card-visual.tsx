'use client'
// The card itself (UI.md §5.10): 85.6 : 54, ink black, the mint's dome and arches in hairline brass, the wordmark, the
// holder's name and the last four. It tilts a few degrees with the pointer or the phone's motion and a soft light follows.
// Tap to flip: the back shows number, expiry and code (fetched on demand, never kept) with copy buttons, then flips back.
// With reduced motion: no tilt, no light, and the flip is a plain swap.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Check, Copy, Snowflake } from 'lucide-react'
import type { Card, CardSecret } from '@zecca/contracts'
import { useReducedMotion } from '@/lib/use-media'
import { cn } from '@/lib/cn'
import { formatExpiry, formatPan, tiltFrom } from './card-logic'

const INK = '#0c0c0d'
const PAPER = '#f2efe8'

/** The mint in line art across the card: dome, pediment, entablature, seven arches. Hairline, nothing filled. */
function MintArt() {
  // Drawn in the upper right so the name and the last four stay clear.
  const arches = Array.from({ length: 7 }, (_, i) => 236 + i * 48)
  const nss = { vectorEffect: 'non-scaling-stroke' as const }
  return (
    <svg viewBox="0 0 600 378" className="absolute inset-0 h-full w-full" fill="none" stroke="var(--brass)" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g strokeWidth={1} opacity={0.75}>
        <path d="M418 30 V 44" {...nss} />
        <path d="M390 74 A 28 28 0 0 1 446 74" {...nss} />
        <path d="M380 74 H 456 M 390 74 V 104 H 446 V 74" {...nss} />
        <path d="M388 108 L 226 160 M 448 108 L 610 160" {...nss} />
        <path d="M226 170 H 610 M 226 181 H 610" {...nss} />
        <path d="M226 268 H 610 M 226 279 H 610" {...nss} />
        {arches.map((x) => (
          <path key={x} d={`M ${x} 268 V 216 A 16 16 0 0 1 ${x + 32} 216 V 268`} {...nss} />
        ))}
      </g>
    </svg>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation()
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* clipboard blocked: the value is on screen */
        }
      }}
      className="grid size-10 shrink-0 place-items-center rounded-full text-[#f2efe8]/80 hover:bg-white/10 hover:text-[#f2efe8]"
      aria-label={`Copy ${label}`}
    >
      {done ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
      <span className="sr-only" aria-live="polite">
        {done ? `${label} copied` : ''}
      </span>
    </button>
  )
}

function Field({ label, value, copy, mono = true, wide = false }: { label: string; value: ReactNode; copy?: string; mono?: boolean; wide?: boolean }) {
  return (
    <div className={cn('flex min-w-0 items-center gap-1', wide && 'w-full')}>
      <div className="min-w-0">
        <div className="text-[10px] font-[650] uppercase tracking-[0.14em] text-[#f2efe8]/55">{label}</div>
        <div className={cn('truncate text-[15px] font-[650] text-[#f2efe8] sm:text-[17px]', mono && 'tabular tracking-[0.06em]')}>{value}</div>
      </div>
      {copy && <CopyButton value={copy} label={label.toLowerCase()} />}
    </div>
  )
}

export function CardVisual({
  card,
  secret,
  secretError,
  flipped,
  onToggle,
  secondsLeft,
  className,
  locked = false,
}: {
  card: Pick<Card, 'last4' | 'expMonth' | 'expYear' | 'state' | 'holderName'>
  secret?: CardSecret | null
  secretError?: string | null
  flipped: boolean
  onToggle?: () => void
  secondsLeft?: number
  className?: string
  /** The locked preview for unverified accounts: no flip, no details. */
  locked?: boolean
}) {
  const reduced = useReducedMotion()
  const el = useRef<HTMLDivElement>(null)
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, lx: 30, ly: 20 })
  const frame = useRef(0)
  const frozen = card.state !== 'OPEN'

  const aim = useCallback((px: number, py: number) => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => setTilt(tiltFrom(px, py)))
  }, [])

  // The phone's motion (where the browser gives it without a prompt): a few degrees around how it is held.
  useEffect(() => {
    if (reduced || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return
    let base: { b: number; g: number } | null = null
    const on = (e: DeviceOrientationEvent) => {
      if (e.beta === null || e.gamma === null) return
      base ??= { b: e.beta, g: e.gamma }
      aim(0.5 + (e.gamma - base.g) / 40, 0.5 + (e.beta - base.b) / 40)
    }
    window.addEventListener('deviceorientation', on)
    return () => window.removeEventListener('deviceorientation', on)
  }, [reduced, aim])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const onMove = (e: React.PointerEvent) => {
    if (reduced || e.pointerType === 'touch' || !el.current) return
    const r = el.current.getBoundingClientRect()
    aim((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height)
  }
  const onLeave = () => {
    if (!reduced) aim(0.5, 0.5)
  }

  const turn = flipped && !locked
  const style = {
    transform: reduced ? undefined : `rotateX(${tilt.rx}deg) rotateY(${tilt.ry + (turn ? 180 : 0)}deg)`,
    transition: reduced ? undefined : 'transform 600ms cubic-bezier(0.22, 0.8, 0.3, 1)',
    transformStyle: 'preserve-3d',
  } as CSSProperties
  const face = 'absolute inset-0 overflow-hidden rounded-[18px] sm:rounded-[22px]'
  const hideFace = { backfaceVisibility: 'hidden', WebkitBackfaceVisibility: 'hidden' } as CSSProperties

  return (
    <div className={cn('mx-auto w-full max-w-[420px] [perspective:1100px]', className)}>
      <div
        ref={el}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        onClick={() => !locked && onToggle?.()}
        className={cn('relative aspect-[85.6/54] w-full select-none', !locked && 'cursor-pointer', frozen && !locked && 'opacity-75 grayscale')}
        style={style}
      >
        {/* Front */}
        <div
          className={cn(face, 'shadow-[0_18px_40px_-18px_rgb(12_12_13/55%),0_2px_6px_rgb(12_12_13/20%)]', reduced && turn && 'invisible')}
          style={{ background: INK, color: PAPER, ...hideFace }}
          inert={turn}
        >
          <MintArt />
          {!reduced && !locked && (
            <div
              className="pointer-events-none absolute inset-0 transition-[background] duration-150"
              style={{ background: `radial-gradient(circle at ${tilt.lx}% ${tilt.ly}%, rgb(255 248 230 / 16%), transparent 55%)` }}
              aria-hidden="true"
            />
          )}
          <div className="relative flex h-full flex-col justify-between p-[6%]">
            <div className="flex items-start justify-between">
              <span className="font-display text-[15px] font-medium uppercase leading-none tracking-[0.24em] sm:text-[17px]">Zecca</span>
              {frozen && !locked ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-white/25 px-2.5 py-1 text-[11px] font-[650] uppercase tracking-[0.12em]">
                  <Snowflake className="size-3" aria-hidden="true" /> Frozen
                </span>
              ) : (
                <span className="text-[10px] font-[650] uppercase tracking-[0.16em] text-[#f2efe8]/60">Virtual</span>
              )}
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[10px] font-[650] uppercase tracking-[0.14em] text-[#f2efe8]/55">Card holder</div>
                <div className="truncate text-[14px] font-[650] uppercase tracking-[0.08em] sm:text-[15px]">{card.holderName || 'Zecca member'}</div>
              </div>
              <div className="tabular shrink-0 text-[17px] font-[650] tracking-[0.14em] sm:text-[19px]" aria-label={locked ? 'Card number hidden' : `Card ending ${card.last4}`}>
                •••• {locked ? '••••' : card.last4}
              </div>
            </div>
          </div>
          {!locked && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onToggle?.()
              }}
              className="absolute inset-0 rounded-[inherit] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-4 focus-visible:outline-[var(--brass)]"
              aria-label="Show card number, expiry and code"
            />
          )}
        </div>

        {/* Back */}
        {!locked && (
          <div
            className={cn(face, reduced && !turn && 'invisible')}
            style={{ background: INK, color: PAPER, transform: reduced ? undefined : 'rotateY(180deg)', ...hideFace }}
            inert={!turn}
            aria-hidden={!turn}
          >
            <div className="absolute inset-x-0 top-[13%] h-[17%] bg-[#1d1e21]" aria-hidden="true" />
            <div className="relative flex h-full flex-col justify-end gap-2 p-[6%]">
              {secret && turn ? (
                <>
                  <Field label="Card number" value={formatPan(secret.pan)} copy={secret.pan} wide />
                  <div className="flex items-center gap-6">
                    <Field label="Expiry" value={formatExpiry(secret.expMonth, secret.expYear)} copy={formatExpiry(secret.expMonth, secret.expYear)} />
                    <Field label="Code" value={secret.cvc} copy={secret.cvc} />
                  </div>
                </>
              ) : secretError ? (
                <p className="text-[14px] text-[#f2efe8]/85" role="alert">
                  {secretError}
                </p>
              ) : (
                <div className="space-y-3" aria-label="Loading card details" aria-busy="true">
                  <span className="block h-5 w-4/5 rounded-[6px] bg-white/12" />
                  <span className="block h-5 w-2/5 rounded-[6px] bg-white/12" />
                </div>
              )}
              <div className="flex items-center justify-between pt-1 text-[11px] text-[#f2efe8]/60">
                <span aria-live="polite">{secret && secondsLeft !== undefined ? `Hides in ${secondsLeft} s` : ' '}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onToggle?.()
                  }}
                  className="min-h-9 rounded-full px-3 font-[650] uppercase tracking-[0.12em] text-[#f2efe8]/85 hover:bg-white/10"
                >
                  Hide
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
