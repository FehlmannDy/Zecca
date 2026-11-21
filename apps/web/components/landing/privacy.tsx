// Privacy, once, below the features: one coffee seen from both sides. You see the shop and the amount; everyone else
// sees an address, the Zecca pool and a sealed amount, drawn as a block of hex (a picture, not real ciphertext).
// Side by side on wide screens, stacked on a phone.
import { Check, Eye, EyeOff, Lock } from 'lucide-react'
import { Amount } from '@/components/zecca/amount'
import { PRIVACY, sealedHex } from './content'
import { Section } from './parts'

// Both cards read the same three lines, From, To and Amount, so the difference is the whole point.
const ROW = 'flex items-center justify-between gap-4 border-b border-dashed py-3.5'

function YouSee() {
  const you = PRIVACY.you
  return (
    <figure className="flex min-w-0 flex-col rounded-[20px] border border-line bg-surface p-6 shadow-[var(--shadow-float)] sm:p-8">
      <figcaption className="flex items-center gap-2 text-[14px] font-[680] text-muted">
        <Eye className="size-4" strokeWidth={1.8} aria-hidden="true" />
        {you.label}
      </figcaption>
      <dl className="mt-5 flex flex-1 flex-col text-[15px]">
        <div className={`${ROW} border-line`}>
          <dt className="text-muted">From</dt>
          <dd className="font-[650] text-ink">{you.from}</dd>
        </div>
        <div className={`${ROW} border-line`}>
          <dt className="text-muted">To</dt>
          <dd className="flex min-w-0 items-center gap-2.5 font-[650] text-ink">
            <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-line text-[10.5px] font-[720]">
              {you.initials}
            </span>
            <span className="truncate">{you.name}</span>
          </dd>
        </div>
        <div className="flex flex-1 flex-col pt-3.5">
          <dt className="flex items-center justify-between text-muted">
            Amount
            <span aria-hidden="true" className="inline-flex items-center gap-1.5 text-[13px] font-[680] text-in">
              <Check className="size-3.5" strokeWidth={2.4} />
              {you.status}
            </span>
          </dt>
          <dd className="mt-3 flex flex-1 flex-col justify-center gap-1.5 rounded-[14px] px-4 py-3.5" style={{ background: 'color-mix(in srgb, var(--paper) 70%, transparent)' }}>
            <Amount minor={you.amountMinor} size="hero" />
            <span className="sr-only">{you.status}</span>
            <span className="text-[13.5px] text-muted">{you.note}</span>
          </dd>
        </div>
      </dl>
    </figure>
  )
}

function OthersSee() {
  const o = PRIVACY.others
  const hex = sealedHex(PRIVACY.you.amountMinor, 4, 12)
  const row = ROW
  const rule = { borderColor: 'color-mix(in srgb, var(--sealed) 22%, var(--line))' }
  // Darker than --muted: muted on the sealed tint falls just under 4.5:1 in light mode.
  const label = 'text-ink/70'
  return (
    <figure
      className="flex min-w-0 flex-col rounded-[20px] border p-6 sm:p-8"
      style={{ borderColor: 'color-mix(in srgb, var(--sealed) 30%, var(--line))', background: 'color-mix(in srgb, var(--sealed) 5%, var(--paper))' }}
    >
      <figcaption className="flex items-center gap-2 text-[14px] font-[680] text-sealed">
        <EyeOff className="size-4" strokeWidth={1.8} aria-hidden="true" />
        {o.label}
      </figcaption>
      <dl className="mt-5 flex flex-1 flex-col text-[15px]">
        <div className={row} style={rule}>
          <dt className={label}>From</dt>
          <dd className="font-[650] text-ink">{o.from}</dd>
        </div>
        <div className={row} style={rule}>
          <dt className={label}>To</dt>
          <dd className="font-[650] text-ink">{o.to}</dd>
        </div>
        <div className="flex flex-1 flex-col pt-3.5">
          <dt className={`flex items-center justify-between ${label}`}>
            Amount
            <span aria-hidden="true" className="inline-flex items-center gap-1.5 text-[13px] font-[680] text-sealed">
              <Lock className="size-3.5" strokeWidth={2} aria-hidden="true" />
              {o.amount}
            </span>
          </dt>
          <dd className="mt-3 flex flex-1 items-center overflow-hidden rounded-[14px] py-3.5 pl-4" style={{ background: 'color-mix(in srgb, var(--sealed) 9%, transparent)' }}>
            <span className="sr-only">{o.amount}</span>
            {/* Lines that run on past the edge and fade: the amount is in there, and nobody outside Zecca can read it. */}
            <span aria-hidden="true" className="block min-w-0 flex-1 select-none overflow-hidden font-mono text-[12.5px] leading-[1.8] tracking-[0.04em] text-sealed [mask-image:linear-gradient(to_right,black_70%,transparent)]">
              {hex.map((line, i) => (
                <span key={i} className="block whitespace-nowrap">
                  {line}
                </span>
              ))}
            </span>
          </dd>
        </div>
      </dl>
    </figure>
  )
}

export function Privacy() {
  return (
    <Section id="privacy" title={PRIVACY.title} intro={PRIVACY.intro}>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-5">
        <YouSee />
        <OthersSee />
      </div>
    </Section>
  )
}
