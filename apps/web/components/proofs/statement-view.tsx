'use client'
// The public statement page (/statement/[id]): each line with its ledger links, Zecca's signature and public key, and an
// in-page "Check signature" that verifies it here, in the browser. Printable (print CSS hides the buttons).
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Check, Download, Printer, ShieldCheck, X } from 'lucide-react'
import * as rk from 'ripple-keypairs'
import { formatUsd, type Network, type PublicConfig, type Statement } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { useResource } from '@/lib/hooks'
import { Button, HashChip, Skeleton } from '@/components/zecca/bits'
import { Logo } from '@/components/zecca/wordmark'
import { cn } from '@/lib/cn'
import { checkSignature, statementTotals, type SignatureCheck } from './statement-verify'

type Line = Statement['lines'][number]

const FALLBACK_EXPLORER: PublicConfig['explorer'] = { devnet: 'https://devnet.xrpl.org/transactions/', testnet: 'https://testnet.xrpl.org/transactions/' }
const txHref = (explorer: PublicConfig['explorer'], network: Network, hash: string) => `${explorer[network].replace(/\/+$/, '')}/${hash}`
const when = (iso: string) => `${new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' })

export function StatementView({ id }: { id: string }) {
  const { api, config } = useApp()
  const st = useResource(() => api.call('disclosureGet', { params: { id } }), [api, id])
  const explorer = config?.explorer ?? FALLBACK_EXPLORER

  return (
    <div className="min-h-dvh bg-paper text-ink print:bg-white">
      <style>{'@page { margin: 14mm } @media print { body { background: #fff !important } }'}</style>
      <div className="mx-auto w-full max-w-[880px] px-4 pb-16 pt-[max(20px,env(safe-area-inset-top))] print:px-0 print:pt-0">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-4">
          <Link href="/" aria-label="Zecca" className="rounded-[10px]">
            <Logo />
          </Link>
          {st.data && (
            <div className="flex gap-2 print:hidden">
              <Button variant="secondary" className="min-h-11 px-4 text-[14px]" onClick={() => window.print()}>
                <Printer className="size-4" aria-hidden="true" /> Print
              </Button>
              <a
                href={api.url('disclosureGet', { id })}
                download={`zecca-statement-${id}.json`}
                className="inline-flex min-h-11 items-center gap-2 rounded-[14px] border border-line bg-surface px-4 text-[14px] font-[680] hover:border-ink/30"
              >
                <Download className="size-4" aria-hidden="true" /> JSON
              </a>
            </div>
          )}
        </header>

        {st.loading ? (
          <div className="space-y-4 pt-8" aria-busy="true" aria-label="Loading the statement">
            <Skeleton className="h-8 w-56" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : st.error || !st.data ? (
          <div className="pt-12">
            <h1 className="text-[24px] font-[720]">This statement is not available.</h1>
            <p className="mt-2 text-[15px] text-muted">Check the link, or ask the person who shared it for a new one.</p>
          </div>
        ) : (
          <StatementBody s={st.data} explorer={explorer} />
        )}
      </div>
    </div>
  )
}

function StatementBody({ s, explorer }: { s: Statement; explorer: PublicConfig['explorer'] }) {
  const totals = useMemo(() => statementTotals(s), [s])
  const proven = s.lines.filter((l) => l.amountProof).length
  return (
    <article className="space-y-8 pt-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label-caps text-muted">Statement</p>
          <h1 className="mt-1 text-[28px] font-[720] leading-tight tracking-[-0.02em]">{s.holder.displayName}</h1>
          <p className="mt-1 text-[14.5px] text-muted">@{s.holder.handle}</p>
          <p className="mt-1 break-all font-mono text-[12.5px] text-muted">{s.holder.address}</p>
        </div>
        <dl className="text-right text-[13.5px]">
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
          <p className="text-[14px] font-[620]">Anyone can check each line on the public ledger.</p>
        </div>
        <ol className="mt-3 divide-y divide-line rounded-[20px] border border-line bg-surface print:rounded-none">
          {s.lines.map((l) => (
            <LineItem key={l.activityId} l={l} explorer={explorer} />
          ))}
        </ol>
        <p className="mt-3 text-[13.5px] text-muted">
          {s.attestation === 'proof'
            ? 'Amounts are hidden on the public ledger. Each amount here comes with a proof that the hidden amount in that transaction is exactly this one, so it can be checked without trusting Zecca.'
            : proven > 0
              ? `Amounts are hidden on the public ledger. ${proven} of ${totals.count} come with a proof that can be checked without trusting Zecca; the others are attested by Zecca.`
              : 'Amounts are hidden on the public ledger, so they are attested by Zecca: its signature below covers every line. The links show that each payment happened.'}
        </p>
      </section>

      <SignatureBlock s={s} />
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

function LineItem({ l, explorer }: { l: Line; explorer: PublicConfig['explorer'] }) {
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
                <HashChip value={h.hash} href={txHref(explorer, l.network, h.hash)} label="Copy transaction" />
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
          {l.amountProof ? 'Amount proven' : 'Attested by Zecca'}
        </span>
      </div>
    </li>
  )
}

function SignatureBlock({ s }: { s: Statement }) {
  const [check, setCheck] = useState<SignatureCheck | null>(null)
  const signer = useMemo(() => {
    try {
      return rk.deriveAddress(s.signature.publicKey)
    } catch {
      return undefined
    }
  }, [s.signature.publicKey])
  return (
    <section aria-labelledby="sig-title" className="rounded-[20px] border border-line bg-surface p-4 print:rounded-none">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sig-title" className="flex items-center gap-2 text-[17px] font-[700]">
            <ShieldCheck className="size-5" aria-hidden="true" /> Signed by Zecca
          </h2>
          <p className="mt-1 max-w-[52ch] text-[13.5px] text-muted">Zecca signs the whole statement. Change one character and the signature no longer matches.</p>
        </div>
        <Button variant="secondary" className="min-h-11 px-4 text-[14px] print:hidden" onClick={() => setCheck(checkSignature(s))}>
          Check signature
        </Button>
      </div>
      <div aria-live="polite" className="mt-3 empty:hidden">
        {check &&
          (check.ok ? (
            <p className="flex items-center gap-2 rounded-[14px] bg-in/10 px-3 py-2 text-[14px] font-[620] text-in">
              <Check className="size-4" aria-hidden="true" /> Signature valid. Signed with the key of {check.signerAddress}.
            </p>
          ) : (
            <p className="flex items-center gap-2 rounded-[14px] bg-alert/10 px-3 py-2 text-[14px] font-[620] text-alert">
              <X className="size-4" aria-hidden="true" /> Signature not valid. {check.reason}
            </p>
          ))}
      </div>
      <dl className="mt-4 grid gap-x-4 gap-y-2 text-[13px] sm:grid-cols-[max-content_1fr]">
        {signer && (
          <>
            <dt className="text-muted">Zecca statement key</dt>
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
      <p className="mt-4 text-[12px] leading-relaxed text-muted">
        How to check it yourself: take this statement as JSON, remove the signature field, sort every object&apos;s keys and drop all spaces; its SHA-256 is the
        fingerprint above, and the signature is an ECDSA {s.signature.alg} signature of that fingerprint, as made by ripple-keypairs. Amount proofs can be checked
        against the public ledger with the open-source verifier in Zecca&apos;s repository (services/api/src/connectors/proofs/verify-cli.ts).
      </p>
    </section>
  )
}
