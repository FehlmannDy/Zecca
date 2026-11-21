// /how-it-works: which network each step runs on (SPEC §2.1), the pool model (SPEC §2.6) and the public proofs.
import { ExternalLink } from 'lucide-react'
import { HOW, NETWORK_ROWS, PAYMENT, POOL_ADDRESS, POOL_MODEL, PROOFS, explorerAccount, explorerTx } from './content'
import { FeatureStatus } from './feature-status'
import { Divider, NetworkChip, Section } from './parts'
import { PoolDiagram } from './pool-diagram'
import { SiteFooter, SiteHeader } from './site-chrome'

const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`

function Networks() {
  return (
    <Section id="networks" label="Step by step" title="Which network does what">
      <ul className="divide-y divide-line rounded-[20px] border border-line bg-surface">
        {NETWORK_ROWS.map((r) => (
          <li key={r.step} className="grid gap-2 p-5 md:grid-cols-[180px_1fr] md:gap-8 md:p-6">
            <div className="flex flex-wrap items-center gap-2 md:flex-col md:items-start">
              <h3 className="text-[16px] font-[720] text-ink">{r.step}</h3>
              {r.feature && <FeatureStatus feature={r.feature} />}
            </div>
            <div>
              <NetworkChip>{r.network}</NetworkChip>
              <p className="mt-2.5 text-[15px] leading-[1.6] text-muted">{r.what}</p>
            </div>
          </li>
        ))}
      </ul>
    </Section>
  )
}

function Pool() {
  return (
    <Section id="pool" label="The pool" title={PAYMENT.title} intro={PAYMENT.intro}>
      <PoolDiagram />
      <ul className="mx-auto mt-14 max-w-[760px] space-y-4">
        {POOL_MODEL.points.map((p) => (
          <li key={p} className="flex gap-3 text-[15.5px] leading-[1.6] text-ink">
            <span aria-hidden="true" className="mt-[10px] size-1.5 shrink-0 rounded-full bg-brass" />
            {p}
          </li>
        ))}
      </ul>
      <p className="mx-auto mt-8 max-w-[760px] text-[14px] text-muted">
        The pool’s address is public:{' '}
        <a href={explorerAccount('devnet', POOL_ADDRESS)} target="_blank" rel="noreferrer" className="break-all font-mono text-[13px] text-ink underline decoration-line underline-offset-4 hover:decoration-ink">
          {POOL_ADDRESS}
        </a>
      </p>
    </Section>
  )
}

function Proofs() {
  return (
    <Section id="proofs" label="On the public ledger" title="See it for yourself" intro="Transactions from our test runs on 20 November 2026. Devnet is reset from time to time, so older links can stop working.">
      <ul className="divide-y divide-line rounded-[20px] border border-line bg-surface">
        {PROOFS.map((p) => (
          <li key={p.hash} className="flex flex-col gap-2 p-5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
            <p className="text-[15px] text-ink">{p.label}</p>
            <a
              href={explorerTx(p.network, p.hash)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-2 self-start font-mono text-[13px] text-ink underline decoration-line underline-offset-4 hover:decoration-ink sm:self-auto"
              title={p.hash}
            >
              {short(p.hash)}
              <span className="font-sans text-[12px] text-muted no-underline">{p.network === 'devnet' ? 'Devnet' : 'Testnet'}</span>
              <ExternalLink className="size-3.5 text-muted" strokeWidth={2} aria-hidden="true" />
            </a>
          </li>
        ))}
      </ul>
    </Section>
  )
}

export function HowItWorks() {
  return (
    <>
      <SiteHeader />
      <main>
        <header className="mx-auto w-full max-w-[1120px] px-4 pb-4 pt-14 sm:px-6 md:pt-20">
          <h1 className="text-[40px] font-[740] leading-[1.05] tracking-[-0.04em] text-ink md:text-[56px]">{HOW.title}</h1>
          <p className="mt-5 max-w-[64ch] text-[17px] leading-[1.6] text-muted">{HOW.intro}</p>
        </header>
        <Networks />
        <Divider />
        <Pool />
        <Divider />
        <Proofs />
      </main>
      <SiteFooter />
    </>
  )
}
