// Landing hero: the product first. One money app on the XRP Ledger, the two ways in, and the Zecca home on a phone
// with the card in front of it. One entrance on load (phone, then card, then the "Paid" note), off with reduced motion.
import { Check } from 'lucide-react'
import { CardArt } from './card-art'
import { HERO, PHONE } from './content'
import { LinkButton } from './parts'
import { Phone } from './phone'

/** The phone stands in one arch of the mint, in hairline, lit with the brass light of the app's backdrop. */
function Niche() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute left-1/2 top-[-8%] h-[112%] w-[142%] -translate-x-1/2 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"
    >
      <svg viewBox="0 0 400 700" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" fill="none" strokeLinecap="round">
        <path d="M1 700 V 200 A 199 199 0 0 1 399 200 V 700" style={{ fill: 'color-mix(in srgb, var(--surface) 45%, transparent)' }} stroke="var(--line)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <path d="M26 700 V 200 A 174 174 0 0 1 374 200 V 700" stroke="var(--line)" strokeWidth="1" opacity="0.7" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="absolute inset-0" style={{ background: 'radial-gradient(55% 40% at 50% 30%, color-mix(in srgb, var(--brass) 18%, transparent), transparent 75%)' }} />
    </div>
  )
}

function HeroVisual() {
  return (
    <div className="relative mx-auto w-full max-w-[480px] pb-4 pt-2" role="img" aria-label="The Zecca app on a phone: the balance, the four actions, the card, Earn and the latest payments, with the Zecca card in front">
      <div className="relative mx-auto mt-10 w-[292px] motion-safe:animate-[z-sheet-in_700ms_var(--ease-out-soft)_both]">
        <Niche />
        {/* The card is tucked behind the phone, its brass mint showing on the right. */}
        <CardArt
          holder={PHONE.holder}
          last4={PHONE.card.last4}
          className="absolute -right-[30%] top-[24%] w-[220px] rotate-[11deg] drop-shadow-[0_26px_28px_rgb(12_12_13/38%)] motion-safe:animate-[z-sheet-in_800ms_var(--ease-out-soft)_250ms_both] sm:-right-[52%] sm:w-[260px]"
        />
        <Phone className="relative" />
        <div className="absolute -left-[4%] top-[7%] flex items-center gap-2.5 rounded-[16px] border border-line bg-surface py-2.5 pl-2.5 pr-4 shadow-[var(--shadow-float)] motion-safe:animate-[z-pop_400ms_var(--ease-out-soft)_700ms_both] sm:-left-[34%]">
          <span className="grid size-8 place-items-center rounded-full text-in" style={{ background: 'color-mix(in srgb, var(--in) 13%, transparent)' }}>
            <Check className="size-4" strokeWidth={2.6} />
          </span>
          <span className="whitespace-nowrap text-[13px] font-[680] text-ink">{PHONE.toast}</span>
        </div>
      </div>
    </div>
  )
}

export function Hero() {
  const [open, merchant] = HERO.actions
  return (
    <section aria-labelledby="hero-title" className="relative overflow-x-clip">
      <div className="mx-auto grid w-full max-w-[1120px] items-center gap-12 px-4 pb-6 pt-10 sm:px-6 md:pt-16 lg:grid-cols-[1.08fr_1fr] lg:gap-8 lg:pb-10 lg:pt-16">
        <div>
          <h1 id="hero-title" className="max-w-[15ch] text-balance text-[42px] font-[760] leading-[1.02] tracking-[-0.045em] text-ink sm:text-[56px] lg:text-[66px]">
            {HERO.title}
          </h1>
          <p className="mt-6 max-w-[46ch] text-[17px] leading-[1.6] text-muted md:text-[19px]">{HERO.sub}</p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <LinkButton href={open.href} className="px-7">
              {open.label}
            </LinkButton>
            <LinkButton href={merchant.href} variant="secondary" className="px-6">
              {merchant.label}
            </LinkButton>
          </div>
        </div>
        <HeroVisual />
      </div>
    </section>
  )
}
