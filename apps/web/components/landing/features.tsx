// The feature showcase, right under the hero: the eight things Zecca does, in the owner's order, each with a small
// picture of it (decoration: the title and the line under it say it in words). A feature whose flag is off in
// GET /v1/config is marked "Coming next".
import type { ReactNode } from 'react'
import { BadgeCheck, Check, CreditCard, Landmark, QrCode, ScanFace, Wallet } from 'lucide-react'
import { formatUsd } from '@zecca/contracts'
import { Amount } from '@/components/zecca/amount'
import { LogoMark } from '@/components/zecca/wordmark'
import { cn } from '@/lib/cn'
import { CardArt } from './card-art'
import { FEATURE_ART, FEATURES, PHONE, PROOFS, type FeatureItem, type FeatureKey } from './content'
import { FeatureStatus } from './feature-status'
import { Section } from './parts'

const LINE = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const tint = (token: string, pct: number) => ({ background: `color-mix(in srgb, var(--${token}) ${pct}%, transparent)` })

function Pill({ children, tone = 'ink', className }: { children: ReactNode; tone?: 'ink' | 'in' | 'brass' | 'muted'; className?: string }) {
  const style = tone === 'in' ? tint('in', 12) : tone === 'brass' ? tint('brass', 14) : tone === 'muted' ? tint('muted', 10) : undefined
  const color = { ink: 'bg-ink text-paper', in: 'text-in', brass: 'text-ink', muted: 'text-muted' }[tone]
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-[680] leading-none', color, className)} style={style}>
      {children}
    </span>
  )
}

function CardArtwork() {
  const r = FEATURE_ART.receipt
  return (
    <div className="absolute inset-0 grid place-items-center">
      <CardArt holder={PHONE.holder} last4={PHONE.card.last4} className="w-[min(68%,300px)] -translate-x-[14%] -translate-y-[6%] -rotate-[7deg] drop-shadow-[0_24px_30px_rgb(12_12_13/35%)] sm:-translate-x-[38%]" />
      <div className="absolute bottom-4 right-4 w-[196px] rounded-[14px] border border-line bg-surface p-3 shadow-[var(--shadow-float)] sm:bottom-auto sm:right-[7%] sm:top-1/2 sm:w-[224px] sm:-translate-y-[30%]">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[12.5px] font-[720] text-ink">{r.shop}</span>
          <Amount minor={r.amountMinor} size="sm" />
        </div>
        <p className="mt-0.5 truncate text-[11.5px] text-muted">{r.item}</p>
        <Pill tone="in" className="mt-2.5">
          <Check className="size-3" strokeWidth={2.6} aria-hidden="true" />
          {r.status}
        </Pill>
      </div>
    </div>
  )
}

function EarnArtwork() {
  // A rising line with the brass glow of the app's charts. A shape, not data: no axis, no number, no rate.
  const d = 'M0 128 C 40 124, 60 112, 92 110 S 150 96, 182 84 S 236 70, 258 54 S 284 38, 296 34'
  return (
    <div className="absolute inset-0">
      {[34, 58, 82].map((y) => (
        <span key={y} className="absolute inset-x-0 border-t border-dashed border-line" style={{ top: `${y}%` }} />
      ))}
      <svg viewBox="0 0 320 160" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-[72%] w-full text-brass">
        <defs>
          <linearGradient id="earn-glow" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--brass)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--brass)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={`${d} V 160 H 0 Z`} fill="url(#earn-glow)" />
        <path d={d} {...LINE} strokeWidth={2.2} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="absolute inset-x-0 bottom-0 h-[72%]">
        <span className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brass ring-[6px] ring-brass/20" style={{ left: `${(296 / 320) * 100}%`, top: `${(34 / 160) * 100}%` }} />
      </div>
      <div className="absolute left-5 top-5 flex flex-wrap gap-2">
        <Pill tone="in">{FEATURE_ART.earn.rate}</Pill>
        <Pill tone="muted">{FEATURE_ART.earn.source}</Pill>
      </div>
    </div>
  )
}

function Sparkline({ values, className }: { values: readonly number[]; className?: string }) {
  if (values.length < 2) return null
  const min = Math.min(...values)
  const span = Math.max(...values) - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 60},${18 - ((v - min) / span) * 16}`).join(' ')
  return (
    <svg viewBox="-1 0 62 20" className={cn('h-5 w-16', className)} {...LINE} strokeWidth={1.6}>
      <polyline points={pts} />
    </svg>
  )
}

function MetalsArtwork() {
  const ring = { XAU: 'border-brass', XAG: 'border-muted/60', XPD: 'border-sealed/50' } as const
  return (
    <div className="absolute inset-0 flex items-center justify-center px-5">
      <div className="w-full max-w-[290px] rounded-[14px] border border-line bg-surface px-3.5 pt-3 shadow-[0_8px_24px_-16px_rgb(40_30_10/30%)]">
        <div className="flex items-center justify-between pb-1">
          <span className="text-[11px] font-[620] text-muted">{FEATURE_ART.metalsNote.unit}</span>
          <Pill tone="brass" className="py-[5px] text-[10.5px]">
            <span className="size-1.5 rounded-full bg-brass" />
            {FEATURE_ART.metalsNote.source}
          </Pill>
        </div>
        <div className="divide-y divide-line">
          {FEATURE_ART.metals.map((m) => (
            <div key={m.symbol} className="flex items-center gap-3 py-[7px]">
              <span className={cn('grid size-[30px] place-items-center rounded-full border-[1.5px] text-[11px] font-[720] text-ink', ring[m.symbol])}>{m.short}</span>
              <span className="min-w-0 flex-1 text-[13px] font-[700] text-ink">{m.name}</span>
              <Sparkline values={m.history} className="text-ink" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function TapArtwork() {
  return (
    <div className="absolute inset-0 grid place-items-center">
      <svg viewBox="0 0 300 170" className="h-[150px] w-auto text-ink" {...LINE}>
        {/* your phone */}
        <g transform="rotate(-14 92 92)" strokeWidth={1.8}>
          <rect x="62" y="34" width="60" height="112" rx="13" fill="var(--surface)" />
          <path d="M84 42 H 100" />
        </g>
        <g transform="translate(76 70) scale(0.034)" stroke="currentColor" strokeWidth="44">
          <path d="M643 103 V 128 M593 185 A 50 50 0 0 1 693 185 M578 185 H 708 M596 185 V 250 H 690 V 185 M592 255 L 197 384 M 694 255 L 1089 384 M197 410 H 1089 M197 845 H 1083" />
          {Array.from({ length: 7 }, (_, i) => 205 + i * 131).map((x) => (
            <path key={x} d={`M ${x} 1138 V 995 A 45 45 0 0 1 ${x + 90} 995 V 1138`} />
          ))}
        </g>
        {/* the shop's phone */}
        <g transform="rotate(14 208 92)" strokeWidth={1.8}>
          <rect x="178" y="34" width="60" height="112" rx="13" fill="var(--surface)" />
          <path d="M200 42 H 216" />
          <circle cx="208" cy="88" r="15" stroke="var(--in)" strokeWidth={2} />
          <path d="M201.5 88.5 L 206 93 L 214.5 84" stroke="var(--in)" strokeWidth={2.2} />
        </g>
        {/* the tap */}
        <g stroke="var(--brass)" strokeWidth={2}>
          <path d="M140 74 A 22 22 0 0 1 140 106" opacity="0.5" />
          <path d="M150 66 A 34 34 0 0 1 150 114" opacity="0.75" />
          <path d="M160 58 A 46 46 0 0 1 160 122" />
        </g>
      </svg>
      <Pill tone="in" className="absolute right-[18%] top-5">
        <Check className="size-3" strokeWidth={2.6} aria-hidden="true" />
        {FEATURE_ART.tap.done}
      </Pill>
      <span className="absolute bottom-4 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap text-[11.5px] font-[620] text-muted">
        <QrCode className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
        {FEATURE_ART.tap.or}
      </span>
    </div>
  )
}

function FaceIdArtwork() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
      <span className="grid size-[84px] place-items-center rounded-[26px] border border-line bg-surface text-ink shadow-[0_10px_26px_-16px_rgb(40_30_10/40%)]">
        <ScanFace className="size-10" strokeWidth={1.3} aria-hidden="true" />
      </span>
      <span className="inline-flex min-h-9 items-center rounded-[12px] bg-ink px-4 text-[12.5px] font-[680] text-paper">{FEATURE_ART.faceid.action}</span>
    </div>
  )
}

function IdentityArtwork() {
  const id = FEATURE_ART.identity
  return (
    <div className="absolute inset-0 flex items-center justify-center px-5">
      <div className="w-full max-w-[260px] rounded-[16px] border border-line bg-surface p-4 shadow-[0_10px_26px_-16px_rgb(40_30_10/40%)]">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-[13px] font-[720] text-in">
            <BadgeCheck className="size-4" strokeWidth={2} aria-hidden="true" />
            {id.status}
          </span>
          <Pill tone="in" className="py-[5px] text-[10.5px]">
            {id.result}
          </Pill>
        </div>
        <dl className="mt-3 space-y-2">
          {id.fields.map((f, i) => (
            <div key={f} className="flex items-center justify-between gap-3">
              <dt className="text-[11px] text-muted">{f}</dt>
              <dd className="h-2 rounded-full bg-line" style={{ width: i === 0 ? 92 : 64 }} />
            </div>
          ))}
        </dl>
        <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-2.5 text-[10.5px] text-muted">
          <Wallet className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
          {id.source}
        </p>
      </div>
    </div>
  )
}

function StatementArtwork() {
  const hash = PROOFS[2]?.hash ?? PROOFS[0].hash
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="w-[240px] -rotate-2 rounded-[10px] border border-line bg-surface p-4 shadow-[0_14px_30px_-18px_rgb(40_30_10/45%)]">
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] font-[740] text-ink">{FEATURE_ART.statement.title}</span>
          <LogoMark className="h-4 text-ink" title="" />
        </div>
        <ul className="mt-3 space-y-2">
          {[78, 58, 70].map((w, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="grid size-4 shrink-0 place-items-center rounded-full text-in" style={tint('in', 14)}>
                <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
              </span>
              <span className="h-1.5 rounded-full bg-ink/70" style={{ width: w }} />
              <span className="ml-auto h-1.5 w-8 rounded-full bg-line" />
            </li>
          ))}
        </ul>
        <p className="mt-3 flex items-center gap-1.5 border-t border-dashed border-line pt-2.5 font-mono text-[10px] text-muted">
          {hash.slice(0, 8)}…{hash.slice(-4)}
          <span className="ml-auto font-sans font-[650] text-in">{FEATURE_ART.statement.check}</span>
        </p>
      </div>
    </div>
  )
}

function TopupArtwork() {
  const chips = FEATURE_ART.topupChips
  const selected = chips[Math.floor(chips.length / 2)]
  const METHOD_ICONS = [CreditCard, Landmark]
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-5">
      <div className="flex gap-2">
        {chips.map((c) => (
          <span key={c} className={cn('tabular inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] font-[700]', c === selected ? 'border-ink bg-ink text-paper' : 'border-line bg-surface text-ink')}>
            {formatUsd(c).replace(/\.00$/, '')}
          </span>
        ))}
      </div>
      <span className="inline-flex min-h-10 w-full max-w-[250px] items-center justify-center rounded-[12px] bg-ink text-[12.5px] font-[680] text-paper">{FEATURE_ART.topup.action}</span>
      <div className="flex gap-4 text-[11.5px] font-[620] text-muted">
        {FEATURE_ART.topup.methods.map((m, i) => {
          const Icon = METHOD_ICONS[i] ?? CreditCard
          return (
            <span key={m} className="inline-flex items-center gap-1.5">
              <Icon className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
              {m}
            </span>
          )
        })}
      </div>
    </div>
  )
}

const ART: Record<FeatureKey, () => ReactNode> = {
  card: CardArtwork,
  earn: EarnArtwork,
  metals: MetalsArtwork,
  tap: TapArtwork,
  faceid: FaceIdArtwork,
  identity: IdentityArtwork,
  proofs: StatementArtwork,
  topup: TopupArtwork,
}

/** Where each tile sits: the card is the wide one; Add money closes the two-column layout on its own row. */
const PLACE: Partial<Record<FeatureKey, string>> = { card: 'md:col-span-2', topup: 'md:col-span-2 lg:col-span-1' }

function Tile({ item }: { item: FeatureItem }) {
  const Art = ART[item.key]
  // The card and Earn share the first row on wide screens, so both are tall there; on a tablet Earn sits beside Metals.
  const art = item.key === 'card' ? 'h-[240px] sm:h-[260px]' : item.key === 'earn' ? 'h-[212px] lg:h-[260px]' : 'h-[212px]'
  const heading = item.key === 'card' ? 'text-[22px]' : item.key === 'earn' ? 'text-[19px] lg:text-[22px]' : 'text-[19px]'
  return (
    <li className={cn('flex min-w-0 flex-col overflow-hidden rounded-[20px] border border-line bg-surface', PLACE[item.key])}>
      <div aria-hidden="true" className={cn('relative overflow-hidden border-b border-line/70', art)} style={{ background: 'color-mix(in srgb, var(--paper) 55%, var(--surface))' }}>
        <Art />
      </div>
      <div className="flex flex-1 flex-col p-6">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <h3 className={cn('font-[720] tracking-[-0.015em] text-ink', heading)}>{item.title}</h3>
          {item.flag && <FeatureStatus feature={item.flag} when="off" />}
        </div>
        <p className="mt-2 max-w-[52ch] text-[15px] leading-[1.6] text-muted">{item.body}</p>
      </div>
    </li>
  )
}

export function Features() {
  return (
    <Section id="features" title={FEATURES.title} intro={FEATURES.intro}>
      <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 lg:gap-5">
        {FEATURES.items.map((f) => (
          <Tile key={f.key} item={f} />
        ))}
      </ul>
    </Section>
  )
}
