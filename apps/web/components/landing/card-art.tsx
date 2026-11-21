// The Zecca card as a picture (UI.md §5.10): ink black, the mint's dome and arches in hairline brass, the wordmark,
// the holder's name and the last four. Static, for the landing; the live, flipping card is components/card/card-visual.
// Sizes are in container units, so the same drawing works as a thumbnail and as the hero card.
import { cn } from '@/lib/cn'

const ARCHES = Array.from({ length: 7 }, (_, i) => 236 + i * 48)

function MintArt() {
  return (
    <svg viewBox="0 0 600 378" className="absolute inset-0 h-full w-full" fill="none" stroke="var(--brass)" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g strokeWidth={1.6} opacity={0.8}>
        <path d="M418 30 V 44" />
        <path d="M390 74 A 28 28 0 0 1 446 74" />
        <path d="M380 74 H 456 M 390 74 V 104 H 446 V 74" />
        <path d="M388 108 L 226 160 M 448 108 L 610 160" />
        <path d="M226 170 H 610 M 226 181 H 610" />
        <path d="M226 268 H 610 M 226 279 H 610" />
        {ARCHES.map((x) => (
          <path key={x} d={`M ${x} 268 V 216 A 16 16 0 0 1 ${x + 32} 216 V 268`} />
        ))}
      </g>
    </svg>
  )
}

export function CardArt({ holder, last4, className, details = true }: { holder: string; last4: string; className?: string; details?: boolean }) {
  return (
    <div className={cn('@container', className)} aria-hidden="true">
      <div
        className="relative aspect-[85.6/54] w-full overflow-hidden rounded-[5.5cqi] text-[#f2efe8] ring-1 ring-white/10"
        style={{ background: 'linear-gradient(135deg, #1b1b1d 0%, #0c0c0d 55%, #050506 100%)' }}
      >
        <MintArt />
        <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 22% 12%, rgb(255 248 230 / 14%), transparent 55%)' }} />
        <div className="relative flex h-full flex-col justify-between p-[6.5cqi]">
          <div className="flex items-start justify-between">
            <span className="font-display text-[5cqi] font-medium uppercase leading-none tracking-[0.24em]">Zecca</span>
            {details && <span className="text-[2.8cqi] font-[650] uppercase leading-none tracking-[0.16em] text-[#f2efe8]/60">Virtual</span>}
          </div>
          {details && (
            <div className="flex items-end justify-between gap-[3cqi]">
              <div className="min-w-0">
                <div className="text-[2.6cqi] font-[650] uppercase tracking-[0.14em] text-[#f2efe8]/55">Card holder</div>
                <div className="truncate text-[4cqi] font-[650] uppercase tracking-[0.08em]">{holder}</div>
              </div>
              <div className="tabular shrink-0 text-[4.8cqi] font-[650] tracking-[0.14em]">•••• {last4}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
