// Sette Archi's line drawings: single-weight strokes in the shop's own ink, nothing filled.
const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

export function CoffeeBag({ className, label = 'A bag of coffee', tone = 'Guji' }: { className?: string; label?: string; tone?: string }) {
  return (
    <svg viewBox="0 0 200 240" className={className} role="img" aria-label={label}>
      <g {...common}>
        <path d="M58 46 L142 46 L152 214 Q100 224 48 214 Z" />
        <path d="M58 46 L66 22 L134 22 L142 46" />
        <path d="M66 22 L72 46 M134 22 L128 46" />
        <path d="M78 34 h44" strokeDasharray="3 5" />
        <rect x="70" y="96" width="60" height="72" rx="6" />
        <circle cx="100" cy="122" r="14" />
        <path d="M93 122 q7 -10 14 0 q-7 10 -14 0" />
        <path d="M80 150 h40 M86 158 h28" />
        <path d="M40 228 q10 -10 20 0 M150 228 q10 -10 20 0" />
      </g>
      <text x="100" y="186" textAnchor="middle" fontSize="11" fill="currentColor" fontFamily="Georgia, serif" letterSpacing="2">
        {tone.toUpperCase()}
      </text>
    </svg>
  )
}

export function MokaPot({ className, label = 'A moka pot' }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 200 240" className={className} role="img" aria-label={label}>
      <g {...common}>
        <path d="M70 120 L62 210 L138 210 L130 120 Z" />
        <path d="M66 120 L134 120" />
        <path d="M74 120 L80 70 L120 70 L126 120" />
        <path d="M80 70 L76 58 L124 58 L120 70" />
        <path d="M96 52 q4 -8 8 0" />
        <path d="M124 76 q30 4 22 34 q-4 10 -16 8" />
        <path d="M76 78 L62 66" />
        <path d="M84 150 h32 M80 176 h40" />
      </g>
    </svg>
  )
}

export function Grinder({ className, label = 'A hand grinder' }: { className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 200 240" className={className} role="img" aria-label={label}>
      <g {...common}>
        <rect x="74" y="92" width="52" height="118" rx="10" />
        <path d="M74 120 h52 M74 186 h52" />
        <path d="M100 92 V64" />
        <path d="M100 64 H154" />
        <circle cx="160" cy="64" r="8" />
        <path d="M86 92 q14 -14 28 0" />
        <path d="M88 140 l24 24 M112 140 l-24 24" opacity="0.6" />
      </g>
    </svg>
  )
}

export function ItemDrawing({ sku, className }: { sku: string; className?: string }) {
  if (sku.startsWith('moka')) return <MokaPot className={className} />
  if (sku.startsWith('grinder')) return <Grinder className={className} />
  return <CoffeeBag className={className} tone={sku.startsWith('huila') ? 'Huila' : 'Guji'} label={sku.startsWith('huila') ? 'A bag of Colombia Huila coffee' : 'A bag of Ethiopia Guji coffee'} />
}
