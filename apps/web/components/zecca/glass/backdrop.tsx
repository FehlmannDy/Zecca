// Zecca's own backdrop for the frosted panels (replaces the dashboard's stock photo): the mint's dome, pediment
// and seven arches drawn in --line on --paper, under a soft light falloff so the frost has something to blur.
// Pure SVG and CSS, no external image, no credit.
const ARCH_W = 150
const ARCH_GAP = 46
const ARCH_R = ARCH_W / 2

function archPath(x: number, base: number, top: number) {
  return `M ${x} ${base} V ${top} A ${ARCH_R} ${ARCH_R} 0 0 1 ${x + ARCH_W} ${top} V ${base}`
}

export function GlassBackdrop() {
  const total = 7 * ARCH_W + 6 * ARCH_GAP
  const x0 = (1440 - total) / 2
  return (
    <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" style={{ background: 'var(--paper)' }}>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 1440 960" preserveAspectRatio="xMidYMid slice" fill="none" stroke="var(--line)" strokeLinecap="round" strokeLinejoin="round">
        {/* dome and lantern */}
        <g strokeWidth="2.5">
          <path d="M720 40 V 70" />
          <path d="M672 132 A 48 48 0 0 1 768 132" />
          <path d="M660 132 H 780" />
          <path d="M680 132 V 178 H 760 V 132" />
          {/* pediment */}
          <path d="M676 186 L 250 318 M 764 186 L 1190 318" />
          <path className="max-lg:hidden" d="M240 344 H 1200 M 240 380 H 1200" />
          {/* cornice above the arcade (wide screens only: on a phone it would run through the text) */}
          <path className="max-lg:hidden" d="M150 640 H 1290 M 150 676 H 1290" />
        </g>
        {/* the seven arches */}
        <g strokeWidth="3">
          {Array.from({ length: 7 }, (_, i) => (
            <path key={i} d={archPath(x0 + i * (ARCH_W + ARCH_GAP), 1010, 790)} />
          ))}
        </g>
      </svg>
      {/* light falloff: warm from the top, cooler from the bottom left */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(55% 45% at 68% 18%, color-mix(in srgb, var(--brass) 16%, transparent), transparent 70%),' +
            'radial-gradient(45% 40% at 12% 88%, color-mix(in srgb, var(--sealed) 9%, transparent), transparent 70%),' +
            'radial-gradient(120% 90% at 50% 40%, transparent 55%, color-mix(in srgb, var(--paper) 70%, var(--ink) 6%) 100%)',
        }}
      />
    </div>
  )
}
