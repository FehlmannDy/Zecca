'use client'
// The public statement page (/statement/[id]): each line with its ledger links, Zecca's signature and public key, and an
// in-page "Check signature" that verifies it here, in the browser. Printable (print CSS hides the buttons).
// On the mock ledger the hashes are simulated: no explorer links, and the page says so (statement-model.ts).
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Check, ChevronDown, Download, Printer, RotateCw, ShieldCheck, X } from 'lucide-react'
import * as rk from 'ripple-keypairs'
import { formatUsd, type Network, type PublicConfig, type Statement } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { useResource } from '@/lib/hooks'
import { useSession } from '@/lib/session'
import { Button, HashChip, Skeleton } from '@/components/zecca/bits'
import { Logo } from '@/components/zecca/wordmark'
import { cn } from '@/lib/cn'
import { ledgerCopy, missingAsNull } from './statement-model'
import { checkSignature, signerStatus, statementFile, statementTotals, type SignatureCheck } from './statement-verify'

type Line = Statement['lines'][number]

const FALLBACK_EXPLORER: PublicConfig['explorer'] = { devnet: 'https://devnet.xrpl.org/transactions/', testnet: 'https://testnet.xrpl.org/transactions/' }
const txHref = (explorer: PublicConfig['explorer'], network: Network, hash: string) => `${explorer[network].replace(/\/+$/, '')}/${hash}`
const when = (iso: string) => `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })

/** Saves the statement from memory: the API is another origin, where the download attribute is ignored. */
function saveJson(s: Statement) {
  const f = statementFile(s)
  const url = URL.createObjectURL(new Blob([f.text], { type: f.type }))
  const a = document.createElement('a')
  a.href = url
  a.download = f.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function StatementView({ id }: { id: string }) {
  const { api, config } = useApp()
  const session = useSession()
  const st = useResource(() => missingAsNull(api.call('disclosureGet', { params: { id } })), [api, id])
  const explorer = config?.explorer ?? FALLBACK_EXPLORER
  // The holder who just created it gets a way back into the app (the logo goes to the landing page).
  const owner = !!session?.user && !!st.data && st.data.holder.handle === session.user.handle

  return (
    <div className="min-h-dvh bg-paper text-ink print:bg-white">
      <style>{'@page { margin: 14mm } @media print { body { background: #fff !important } }'}</style>
      <div className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-[max(20px,env(safe-area-inset-top))] print:px-0 print:pt-0">
        {owner && (
          <nav aria-label="Back" className="-ml-2 pb-2 print:hidden">
            <Link href="/app/proofs" className="inline-flex min-h-11 items-center gap-1.5 rounded-[12px] px-2 text-[14px] font-[650] text-ink hover:bg-ink/[0.04]">
              <ArrowLeft className="size-4" aria-hidden="true" /> Back to statements
            </Link>
          </nav>
        )}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <Link href="/" aria-label="Zecca" className="rounded-[10px]">
            <Logo />
          </Link>
          {st.data && (
            <div className="flex gap-2 print:hidden">
              <Button variant="secondary" className="min-h-11 px-4 text-[14px]" onClick={() => window.print()}>
                <Printer className="size-4" aria-hidden="true" /> Print
              </Button>
              <Button variant="secondary" className="min-h-11 px-4 text-[14px]" onClick={() => saveJson(st.data!)}>
                <Download className="size-4" aria-hidden="true" /> JSON
              </Button>
            </div>
          )}
        </header>

        {st.loading ? (
          <div className="space-y-4 pt-8" aria-busy="true" aria-label="Loading the statement">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : st.error ? (
          <div className="flex flex-col items-start gap-3 pt-12" role="alert">
            <h1 className="text-[24px] font-[720]">This statement could not be loaded.</h1>
            <p className="text-[15px] text-muted">{st.error}</p>
            <Button variant="secondary" className="min-h-11 px-4 text-[14px]" onClick={st.reload}>
              <RotateCw className="size-4" aria-hidden="true" /> Try again
            </Button>
          </div>
        ) : !st.data ? (
          <div className="pt-12">
            <h1 className="text-[24px] font-[720]">This statement is not available.</h1>
            <p className="mt-2 text-[15px] text-muted">Check the link, or ask the person who shared it for a new one.</p>
          </div>
        ) : (
          <StatementBody s={st.data} explorer={explorer} config={config} simulated={config?.ledgerMode === 'mock'} />
        )}
      </div>
    </div>
  )
}

function StatementBody({ s, explorer, config, simulated }: { s: Statement; explorer: PublicConfig['explorer']; config: PublicConfig | null | undefined; simulated: boolean }) {
  const totals = useMemo(() => statementTotals(s), [s])
  const copy = ledgerCopy(s, simulated)
  return (
    <article className="space-y-8 pt-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps text-muted">Statement</p>
          <h1 className="mt-1 text-[28px] font-[720] leading-tight tracking-[-0.02em]">{s.holder.displayName}</h1>
          <p className="mt-1 text-[14.5px] text-muted">@{s.holder.handle}</p>
        </div>
        <dl className="text-[13.5px] sm:text-right">
          <dt className="text-muted">Issued</dt>
          <dd className="font-[620]">{when(s.createdAt)}</dd>
          <dt className="mt-1 text-muted">Reference</dt>
          <dd className="font-mono text-[12.5px]">{s.id}</dd>
        </dl>
      </section>

      <section className="grid grid-cols-3 gap-3" aria-label="Totals">
        <Total label="Received" minor={totals.inMinor} />
        <Total label="Sent" minor={totals.outMinor} />
        <Total label="Fees" minor={totals.feeMinor} />
      </section>

      <section aria-labelledby="lines-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="lines-title" className="text-[18px] font-[700]">
            {totals.count} {totals.count === 1 ? 'payment' : 'payments'}
          </h2>
          <p className={cn('text-[14px]', simulated ? 'text-muted' : 'font-[620]')}>{copy.headline}</p>
        </div>
        <ol className="mt-3 divide-y divide-line rounded-[20px] border border-line bg-surface print:rounded-none">
          {s.lines.map((l) => (
            <LineItem key={l.activityId} l={l} explorer={copy.links ? explorer : null} />
          ))}
        </ol>
        <p className="mt-3 text-[13.5px] text-muted">{copy.amounts}</p>
      </section>

      <SignatureBlock s={s} config={config} />
    </article>
  )
}

function Total({ label, minor }: { label: string; minor: number }) {
  return (
    <div className="rounded-[20px] border border-line bg-surface px-4 py-3 print:rounded-none">
      <p className="text-[12.5px] text-muted">{label}</p>
      <p className="mt-0.5 text-[18px] font-[700] tabular-nums tracking-[-0.01em]">{formatUsd(minor)}</p>
    </div>
  )
}

/** `explorer` is null on the mock ledger: the hashes are simulated, so they are shown without a link. */
function LineItem({ l, explorer }: { l: Line; explorer: PublicConfig['explorer'] | null }) {
  const hashes = [
    l.depositTxHash ? { label: l.direction === 'out' ? 'Your payment' : 'Payment in', hash: l.depositTxHash } : null,
    l.payoutTxHash ? { label: l.direction === 'out' ? 'Delivery' : 'Paid to you', hash: l.payoutTxHash } : null,
  ].filter((x): x is { label: string; hash: string } => !!x)
  return (
    <li className="grid gap-2 px-4 py-3.5 sm:grid-cols-[1fr_auto] sm:items-start">
      <div className="min-w-0">
        <p className="text-[15px] font-[660]">{l.counterparty}</p>
        <p className="text-[13px] text-muted">
          {day(l.date)} · {l.direction === 'in' ? 'Received' : 'Sent'}
          {l.feeMinor > 0 ? ` · Fee ${formatUsd(l.feeMinor)}` : ''}
        </p>
        {hashes.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5">
            {hashes.map((h) => (
              <span key={h.hash} className="flex items-center gap-1.5 text-[12.5px] text-muted">
                {h.label}
                <span className="print:hidden">
                  <HashChip value={h.hash} href={explorer ? txHref(explorer, l.network, h.hash) : undefined} label="Copy transaction" />
                </span>
                <span className="hidden font-mono text-[10px] print:inline">{h.hash}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 sm:flex-col sm:items-end">
        <p className={cn('text-[17px] font-[700] tabular-nums', l.direction === 'in' && 'text-in')}>
          {l.direction === 'in' ? '+' : ''}
          {formatUsd(l.amountMinor)}
        </p>
        <span className={cn('rounded-full border px-2.5 py-0.5 text-[12px] font-[620]', l.amountProof ? 'border-in/40 text-in' : 'border-line text-muted')}>
          {l.amountProof ? 'Amount proof included' : 'Attested by Zecca'}
        </span>
      </div>
    </li>
  )
}

function SignatureBlock({ s, config }: { s: Statement; config: PublicConfig | null | undefined }) {
  const [check, setCheck] = useState<SignatureCheck | null>(null)
  const signer = useMemo(() => {
    try {
      return rk.deriveAddress(s.signature.publicKey)
    } catch {
      return undefined
    }
  }, [s.signature.publicKey])
  // Zecca's key only when the config publishes it and it is this one; otherwise the page names the key, nothing more.
  const status = signerStatus(signer, config)
  return (
    <section aria-labelledby="sig-title" className="rounded-[20px] border border-line bg-surface p-4 print:rounded-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sig-title" className="flex items-center gap-2 text-[17px] font-[700]">
            <ShieldCheck className="size-5" aria-hidden="true" /> {status === 'other' ? "Not signed with Zecca's statement key" : 'Signed by Zecca'}
          </h2>
          <p className="mt-1 max-w-[52ch] text-[13.5px] text-muted">Zecca signs the whole statement. Change one character and the signature no longer matches.</p>
        </div>
        <Button variant="secondary" className="min-h-11 px-4 text-[14px] print:hidden" onClick={() => setCheck(checkSignature(s))}>
          Check signature
        </Button>
      </div>
      <div aria-live="polite" className="mt-3 empty:hidden">
        {check &&
          (check.ok && status === 'other' ? (
            <p className="flex items-center gap-2 rounded-[14px] bg-alert/10 px-3 py-2 text-[14px] font-[620] text-alert">
              <X className="size-4" aria-hidden="true" /> The signature matches, but {check.signerAddress} is not Zecca&apos;s statement key.
            </p>
          ) : check.ok ? (
            <p className="flex items-center gap-2 rounded-[14px] bg-in/10 px-3 py-2 text-[14px] font-[620] text-in">
              <Check className="size-4" aria-hidden="true" /> Signature valid. Signed with {status === 'zecca' ? "Zecca's statement key" : 'the key of'} {check.signerAddress}.
            </p>
          ) : (
            <p className="flex items-center gap-2 rounded-[14px] bg-alert/10 px-3 py-2 text-[14px] font-[620] text-alert">
              <X className="size-4" aria-hidden="true" /> Signature not valid. {check.reason}
            </p>
          ))}
      </div>
      {/* The keys and the recipe are for whoever checks it by hand: folded on screen, printed in full. */}
      <details className="group mt-3 print:hidden">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-[12px] text-[14px] font-[650] text-ink [&::-webkit-details-marker]:hidden">
          For developers <ChevronDown className="size-4 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden="true" />
        </summary>
        <TechnicalDetails s={s} signer={signer} status={status} />
        <p className="mt-4 text-[12px] leading-relaxed text-muted">
          How to check it yourself: take this statement as JSON, remove the signature field, and write it as compact JSON with every object&apos;s keys sorted;
          its SHA-256 is the fingerprint above, and the signature is an ECDSA {s.signature.alg} signature of that fingerprint, as made by ripple-keypairs. Amount proofs can be checked
          against the public ledger with the open-source verifier in Zecca&apos;s repository (services/api/src/connectors/proofs/verify-cli.ts), with Zecca&apos;s statement key
          pinned (--signer).
        </p>
      </details>
      <div className="mt-4 hidden print:block">
        <TechnicalDetails s={s} signer={signer} status={status} />
      </div>
    </section>
  )
}

function TechnicalDetails({ s, signer, status }: { s: Statement; signer: string | undefined; status: ReturnType<typeof signerStatus> }) {
  return (
    <dl className="mt-2 grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[max-content_1fr]">
      <dt className="text-muted">Holder&apos;s ledger account</dt>
      <dd className="break-all font-mono">{s.holder.address}</dd>
      {signer && (
        <>
          <dt className="text-muted">{status === 'zecca' ? 'Zecca statement key' : 'Signing key'}</dt>
          <dd className="break-all font-mono">{signer}</dd>
        </>
      )}
      <dt className="text-muted">Public key</dt>
      <dd className="break-all font-mono">{s.signature.publicKey}</dd>
      <dt className="text-muted">Content fingerprint</dt>
      <dd className="break-all font-mono">SHA-256 {s.signature.signedPayloadSha256}</dd>
      <dt className="text-muted">Signature</dt>
      <dd className="break-all font-mono text-[11.5px]">{s.signature.value}</dd>
    </dl>
  )
}
