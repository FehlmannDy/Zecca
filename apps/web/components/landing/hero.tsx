// Landing hero (UI §5.1): wordmark, the promise, the two ways in, and one payment seen from both sides.
import { ArrowRight, Check } from 'lucide-react'
import { Amount } from '@/components/zecca/amount'
import { LogoMark, Wordmark } from '@/components/zecca/wordmark'
import { HERO } from './content'
import { LinkButton, SealedBlock } from './parts'

export function Hero() {
  const [open, merchant] = HERO.actions
  return (
    <section aria-labelledby="hero-title" className="relative overflow-hidden">
      <div className="mx-auto grid w-full max-w-[1120px] items-center gap-12 px-4 pb-16 pt-12 sm:px-6 md:pb-24 md:pt-20 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
        <div>
          <div className="flex items-center gap-3 text-ink">
            <LogoMark className="h-12" title="" />
            <Wordmark size="lg" />
          </div>
          <h1 id="hero-title" className="mt-8 max-w-[16ch] text-[40px] font-[740] leading-[1.04] tracking-[-0.04em] text-ink sm:text-[52px] lg:text-[60px]">
            {HERO.title}
          </h1>
          <p className="mt-6 max-w-[44ch] text-[17px] leading-[1.6] text-muted md:text-[19px]">{HERO.sub}</p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <LinkButton href={open.href} className="px-6">
              {open.label}
              <ArrowRight className="size-4" strokeWidth={2} aria-hidden="true" />
            </LinkButton>
            <LinkButton href={merchant.href} variant="secondary" className="px-6">
              {merchant.label}
            </LinkButton>
          </div>
        </div>
        <TwoViews />
      </div>
    </section>
  )
}

/** The product in one picture: the same payment, as you see it and as the public ledger sees it. */
function TwoViews() {
  const { you, others } = HERO.views
  return (
    <figure className="relative mx-auto w-full max-w-[440px]" aria-label="One payment, seen by you and by everyone else">
      <div className="rounded-[20px] border border-line bg-surface p-5 shadow-[var(--shadow-float)] sm:p-6">
        <p className="label-caps text-muted">{you.label}</p>
        <div className="mt-4 flex items-center gap-3.5">
          <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-[12px] border border-line text-[16px] font-[700] text-ink">
            CB
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[16px] font-[680] text-ink">{you.name}</p>
            <p className="truncate text-[13.5px] text-muted">{you.note}</p>
          </div>
          <Amount minor={you.amountMinor} size="lg" />
        </div>
        <p className="mt-4 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[13px] font-[650] text-in" style={{ background: 'color-mix(in srgb, var(--in) 10%, transparent)' }}>
          <Check className="size-3.5" strokeWidth={2.4} aria-hidden="true" />
          {you.status}
        </p>
      </div>

      <div aria-hidden="true" className="mx-auto h-8 w-px bg-line" />

      <div className="rounded-[20px] border border-dashed p-5 sm:p-6" style={{ borderColor: 'color-mix(in srgb, var(--sealed) 35%, var(--line))', background: 'color-mix(in srgb, var(--sealed) 4%, var(--paper))' }}>
        <p className="label-caps text-sealed">{others.label}</p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-5 gap-y-3 text-[14.5px]">
          <dt className="text-muted">From</dt>
          <dd className="font-[620] text-ink">{others.from}</dd>
          <dt className="text-muted">To</dt>
          <dd className="font-[620] text-ink">{others.to}</dd>
          <dt className="text-muted">Amount</dt>
          <dd>
            <SealedBlock label={others.amount} />
          </dd>
        </dl>
      </div>
    </figure>
  )
}
