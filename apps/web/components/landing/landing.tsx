// The landing page (/), UI §5.1. Desktop first, one column on a phone. The arches divide the sections.
import { Check, Clock } from 'lucide-react'
import { BUILDING_BLOCKS, EARNINGS, FACTS, LEDGER, PAYMENT } from './content'
import { Hero } from './hero'
import { BLOCK_ICONS, Divider, FACT_ICONS, IconBadge, NetworkChip, Section } from './parts'
import { PoolDiagram } from './pool-diagram'
import { SiteFooter, SiteHeader } from './site-chrome'

function Facts() {
  return (
    <section aria-label="Why Zecca" className="mx-auto w-full max-w-[1120px] px-4 pb-16 sm:px-6 md:pb-24">
      <ul className="grid gap-4 md:grid-cols-3 md:gap-5">
        {FACTS.map((f) => (
          <li key={f.icon} className="rounded-[20px] border border-line bg-surface p-6">
            <IconBadge icon={FACT_ICONS[f.icon]} />
            <p className="mt-5 text-[17px] font-[720] tracking-[-0.01em] text-ink">{f.title}</p>
            <p className="mt-1.5 text-[15px] leading-[1.6] text-muted">{f.body}</p>
          </li>
        ))}
      </ul>
    </section>
  )
}

function BuildingBlocks() {
  return (
    <Section id="ledger" title={LEDGER.title} intro={LEDGER.intro}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5">
        {BUILDING_BLOCKS.map((b) => (
          <li key={b.title} className="flex flex-col rounded-[20px] border border-line bg-surface p-6">
            <IconBadge icon={BLOCK_ICONS[b.icon]} />
            <h3 className="mt-5 text-[17px] font-[720] tracking-[-0.01em] text-ink">{b.title}</h3>
            <p className="mt-1.5 flex-1 text-[14.5px] leading-[1.6] text-muted">{b.body}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {b.networks.map((n) => (
                <NetworkChip key={n}>{n}</NetworkChip>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Earnings() {
  const groups = [
    { title: 'Live', icon: Check, items: EARNINGS.live, tone: 'text-in' },
    { title: 'Planned', icon: Clock, items: EARNINGS.planned, tone: 'text-muted' },
  ] as const
  return (
    <Section id="earn" title={EARNINGS.title} intro={EARNINGS.note}>
      <div className="grid gap-4 md:grid-cols-2 md:gap-5">
        {groups.map((g) => (
          <div key={g.title} className="rounded-[20px] border border-line bg-surface p-6">
            <h3 className={`label-caps flex items-center gap-1.5 ${g.tone}`}>
              <g.icon className="size-3.5" strokeWidth={2.2} aria-hidden="true" />
              {g.title}
            </h3>
            <ul className="mt-4 divide-y divide-line">
              {g.items.map((e) => (
                <li key={e.title} className="py-4 first:pt-1 last:pb-0">
                  <p className="text-[16px] font-[700] text-ink">{e.title}</p>
                  <p className="mt-1 text-[14.5px] leading-[1.55] text-muted">{e.body}</p>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Section>
  )
}

export function Landing() {
  return (
    <>
      <SiteHeader brand={false} />
      <main>
        <Hero />
        <Facts />
        <Divider />
        <Section id="how" title={PAYMENT.title} intro={PAYMENT.intro}>
          <PoolDiagram />
        </Section>
        <Divider />
        <BuildingBlocks />
        <Divider />
        <Earnings />
      </main>
      <SiteFooter />
    </>
  )
}
