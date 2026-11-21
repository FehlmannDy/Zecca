'use client'
// Identity (UI.md §5.10, SPEC §4.8): "Verify with your EU Digital Identity Wallet" / what will be shared / a QR code on a
// wide screen, "Open wallet" on a phone (EU wallet or other wallets such as Paradym) / waiting with the arches /
// the verified facts and the one approval / "Verified. Limits raised." In IDENTITY_MODE=mock the screen says "Test identity".
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import QRCode from 'qrcode'
import { ArrowLeft, ShieldCheck } from 'lucide-react'
import type { IdentitySession } from '@zecca/contracts'
import type { z } from 'zod'
import { ApproveSheet, type ApproveOutcome } from '@/components/zecca/approve-sheet'
import { ArchesProgress } from '@/components/zecca/arches'
import { Button, Skeleton } from '@/components/zecca/bits'
import { Panel } from '@/components/zecca/glass'
import { isApiError } from '@/lib/api'
import { useApp } from '@/lib/app'
import { cn } from '@/lib/cn'
import { sessionStore, useSession } from '@/lib/session'
import { useMediaQuery } from '@/lib/use-media'
import { approveIdentity, formatBirthDate, liftedLimitsLine, nextPollMs, POLL_MS, viewOf, walletLink, WALLETS, type View, type WalletId } from './flow'

type Session = z.output<typeof IdentitySession>
type Phase = { kind: 'intro' } | { kind: 'starting' } | { kind: 'start-failed'; message: string } | { kind: 'session'; session: Session; view: View; pollError?: string }

const TITLE = 'Verify with your EU Digital Identity Wallet'
const DONE = 'Verified. Limits raised.'

export function IdentityScreen() {
  const { api, config, getSigner } = useApp()
  const user = useSession()?.user
  const [phase, setPhase] = useState<Phase>({ kind: 'intro' })
  const [approveOpen, setApproveOpen] = useState(false)
  const autoOpened = useRef<string | null>(null)
  /** The session whose approval was already pressed once: a retry asks the server again instead of resending a used one. */
  const attempted = useRef<string | null>(null)

  const start = useCallback(async (test = false) => {
    setPhase({ kind: 'starting' })
    try {
      const session = await api.call('identitySessionCreate', test ? { query: { test: '1' } } : {})
      setPhase({ kind: 'session', session, view: { kind: 'waiting' } })
    } catch (e) {
      setPhase({ kind: 'start-failed', message: e instanceof Error && e.message ? e.message : "That didn't work. Try again." })
    }
  }, [api])

  // Poll while waiting (every 2 s, until the session expires; the last poll brings the "expired" message).
  const sessionId = phase.kind === 'session' ? phase.session.id : null
  const waiting = phase.kind === 'session' && phase.view.kind === 'waiting' && !phase.pollError
  const expiresAt = phase.kind === 'session' ? phase.session.expiresAt : null
  useEffect(() => {
    if (!waiting || !sessionId || !expiresAt) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastCall = false
    const tick = async () => {
      try {
        const s = await api.call('identitySessionGet', { params: { id: sessionId } })
        if (!live) return
        const view = viewOf(s)
        if (view.kind !== 'waiting') return setPhase((p) => (p.kind === 'session' && p.session.id === sessionId ? { ...p, view } : p))
      } catch (e) {
        if (!live) return
        // A ledger or server error is shown with "Try again"; a dropped connection just retries.
        if (isApiError(e) && e.status !== 0) return setPhase((p) => (p.kind === 'session' && p.session.id === sessionId ? { ...p, pollError: e.message } : p))
      }
      const wait = nextPollMs(expiresAt, Date.now())
      if (wait !== null) timer = setTimeout(tick, wait)
      else if (!lastCall) {
        // One more poll after the expiry brings the server's own message.
        lastCall = true
        timer = setTimeout(tick, POLL_MS)
      } else setPhase((p) => (p.kind === 'session' && p.session.id === sessionId ? { ...p, view: { kind: 'failed', message: 'This check has expired. Start again.' } } : p))
    }
    timer = setTimeout(tick, POLL_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, waiting, sessionId, expiresAt])

  // The approval opens by itself once, when it arrives.
  useEffect(() => {
    if (phase.kind === 'session' && phase.view.kind === 'approve' && autoOpened.current !== phase.session.id) {
      autoOpened.current = phase.session.id
      setApproveOpen(true)
    }
  }, [phase])

  async function approve(): Promise<ApproveOutcome> {
    if (phase.kind !== 'session' || phase.view.kind !== 'approve') throw new Error('Start the identity check again.')
    const id = phase.session.id
    const retry = attempted.current === id
    attempted.current = id
    const lifted = await approveIdentity(
      {
        session: () => api.call('identitySessionGet', { params: { id } }),
        submit: async (p) => {
          const { tx_blob } = await (await getSigner()).sign(p.tx)
          return api.call('txSubmit', { body: { prepareId: p.prepareId, txBlob: tx_blob } })
        },
        me: () => api.call('me'),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
      },
      phase.view.prepared,
      retry,
    )
    sessionStore().update({ user: lifted })
    return { title: DONE, line: config ? liftedLimitsLine(config.limits) : undefined, announce: DONE }
  }

  if (!config || !user) return <ScreenSkeleton />
  if (!config.features.identity) {
    return (
      <Frame>
        <Panel className="flex flex-col items-start gap-4">
          <p className="text-[15px] text-muted">Identity checks are not available yet.</p>
          <HomeLink />
        </Panel>
      </Frame>
    )
  }

  const sheet =
    phase.kind === 'session' && phase.view.kind === 'approve' ? (
      <ApproveSheet
        open={approveOpen}
        onClose={() => setApproveOpen(false)}
        title="Raise your limits"
        subline="Adds Zecca's check to your account. Your name and date of birth are not made public."
        feeMinor={0}
        expectedMs={8_000}
        run={approve}
        onDone={() => setApproveOpen(false)}
      />
    ) : null

  // Verified (now or before): the limits are lifted.
  if (user.tier === 1 && !approveOpen) {
    return (
      <Frame>
        <Panel className="flex flex-col items-start gap-3">
          <span className="grid size-12 place-items-center rounded-full border border-line text-in">
            <ShieldCheck className="size-6" aria-hidden="true" />
          </span>
          <h2 className="text-[22px] font-[740] leading-tight tracking-[-0.02em]">{DONE}</h2>
          <p className="text-[15px] text-muted">{liftedLimitsLine(config.limits)}</p>
          <HomeLink primary />
        </Panel>
      </Frame>
    )
  }

  if (phase.kind === 'intro' || phase.kind === 'starting' || phase.kind === 'start-failed') {
    return (
      <Frame>
        <Panel className="flex flex-col gap-5">
          <div>
            <h2 className="text-[22px] font-[740] leading-tight tracking-[-0.02em]">{TITLE}</h2>
            <p className="mt-2 text-[15px] text-muted">Unverified accounts have limits. Verify once to lift them.</p>
          </div>
          <Shared />
          {phase.kind === 'start-failed' && (
            <p className="text-[15px] text-alert" role="alert">
              {phase.message}
            </p>
          )}
          <Button className="w-full" onClick={() => start()} disabled={phase.kind === 'starting'} aria-busy={phase.kind === 'starting' || undefined}>
            {phase.kind === 'start-failed' ? 'Try again' : 'Continue'}
          </Button>
        </Panel>
      </Frame>
    )
  }

  const { session, view } = phase
  const mock = session.mode === 'mock'
  return (
    <Frame testIdentity={mock}>
      {view.kind === 'waiting' && (
        <Panel className="flex flex-col gap-5">
          <div>
            <h2 className="text-[22px] font-[740] leading-tight tracking-[-0.02em]">{TITLE}</h2>
            <p className="mt-2 text-[15px] text-muted">Your name and date of birth. Nothing else.</p>
          </div>
          {mock ? (
            <p className="rounded-[16px] border border-line bg-paper px-4 py-3 text-[14.5px] text-muted">This demo uses a test identity. No wallet is needed.</p>
          ) : (
            <>
              <WalletLink link={session.deepLink} />
              {config.demoMode && (
                <button type="button" onClick={() => start(true)} className="self-center min-h-11 text-[14.5px] font-[650] text-muted underline decoration-line underline-offset-4 hover:text-ink">
                  No EU wallet? Use a test identity
                </button>
              )}
            </>
          )}
          {phase.pollError ? (
            <div className="flex flex-col gap-3" role="alert">
              <p className="text-[15px] text-alert">{phase.pollError}</p>
              <Button variant="secondary" onClick={() => setPhase({ ...phase, pollError: undefined })}>
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 pt-1">
              <ArchesProgress state="running" expectedMs={mock ? 3_000 : 60_000} className="h-10" label="Waiting for your wallet" />
              <p className="text-[14.5px] text-muted">{mock ? 'Checking the test identity…' : 'Waiting for your wallet…'}</p>
            </div>
          )}
          <Button variant="ghost" className="w-full" onClick={() => setPhase({ kind: 'intro' })}>
            Cancel
          </Button>
        </Panel>
      )}

      {(view.kind === 'approve' || view.kind === 'verified') && (
        <Panel className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-full border border-line text-in">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </span>
            <h2 className="text-[20px] font-[740] tracking-[-0.02em]">Verified</h2>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 rounded-[16px] border border-line px-4 py-3.5 text-[15px]">
            <dt className="text-muted">Name</dt>
            <dd className="font-[650]">
              {view.identity.givenName} {view.identity.familyName}
            </dd>
            <dt className="text-muted">Date of birth</dt>
            <dd className="font-[650]">{formatBirthDate(view.identity.birthDate)}</dd>
            <dt className="text-muted">Over 18</dt>
            <dd className="font-[650]">{view.identity.over18 ? 'Yes' : 'No'}</dd>
          </dl>
          {view.kind === 'approve' ? (
            <>
              <p className="text-[15px] text-muted">One approval and your limits are lifted.</p>
              <Button className="w-full" onClick={() => setApproveOpen(true)}>
                Raise my limits
              </Button>
            </>
          ) : (
            <>
              {view.message && <p className="text-[15px] text-ink">{view.message}</p>}
              <HomeLink />
            </>
          )}
        </Panel>
      )}

      {view.kind === 'failed' && (
        <Panel className="flex flex-col gap-4">
          <p className="text-[15px] text-alert" role="alert">
            {view.message}
          </p>
          <Button className="w-full" onClick={() => start()}>
            Start again
          </Button>
          <HomeLink />
        </Panel>
      )}
      {sheet}
    </Frame>
  )
}

function Frame({ children, testIdentity = false }: { children: React.ReactNode; testIdentity?: boolean }) {
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4">
      <div className="flex items-center gap-2">
        <Link href="/app" className="-ml-2 grid size-11 place-items-center rounded-full text-ink hover:bg-ink/5" aria-label="Back to home">
          <ArrowLeft className="size-5" aria-hidden="true" />
        </Link>
        <h1 className="text-[22px] font-[740] tracking-[-0.02em]">Identity</h1>
        {testIdentity && <span className="ml-auto rounded-full border border-line bg-surface px-3 py-1 text-[12.5px] font-[650] text-muted">Test identity</span>}
      </div>
      {children}
    </div>
  )
}

function Shared() {
  return (
    <div className="flex items-start gap-3 rounded-[16px] border border-line px-4 py-3.5">
      <ShieldCheck className="mt-0.5 size-5 shrink-0 text-sealed" aria-hidden="true" />
      <div>
        <p className="text-[13px] font-[650] uppercase tracking-[0.08em] text-muted">What will be shared</p>
        <p className="mt-1 text-[15px] font-[650]">Your name and date of birth. Nothing else.</p>
      </div>
    </div>
  )
}

function HomeLink({ primary = false }: { primary?: boolean }) {
  return (
    <Link
      href="/app"
      className={cn(
        'inline-flex min-h-12 items-center justify-center rounded-[14px] px-5 text-[15px] font-[680]',
        primary ? 'w-full bg-ink text-paper hover:opacity-90' : 'border border-line bg-surface text-ink',
      )}
    >
      Go to home
    </Link>
  )
}

/** QR code on a wide screen, "Open wallet" on a phone; a small switch picks the link scheme for the wallet. */
function WalletLink({ link }: { link: string }) {
  const wide = useMediaQuery('(min-width: 768px)')
  const [wallet, setWallet] = useState<WalletId>('eudi')
  const [showQr, setShowQr] = useState(false)
  const url = walletLink(link, wallet)
  const qrShown = wide || showQr
  const qr = useQr(qrShown ? url : null)
  return (
    <div className="flex flex-col items-center gap-4">
      <div role="radiogroup" aria-label="Your wallet" className="inline-flex rounded-full border border-line bg-surface p-1">
        {WALLETS.map((w) => (
          <button
            key={w.id}
            type="button"
            role="radio"
            aria-checked={wallet === w.id}
            onClick={() => setWallet(w.id)}
            className={cn('min-h-10 rounded-full px-4 text-[13.5px] font-[650] transition-colors', wallet === w.id ? 'bg-ink text-paper' : 'text-muted hover:text-ink')}
          >
            {w.label}
          </button>
        ))}
      </div>
      {qrShown && (
        <div className="flex flex-col items-center gap-2">
          <div className="rounded-[16px] border border-line bg-white p-3">
            {qr ? <img src={qr} alt="QR code to open in your wallet" width={220} height={220} className="size-[220px]" /> : <Skeleton className="size-[220px]" />}
          </div>
          <p className="text-[14px] text-muted">Scan with your wallet app.</p>
        </div>
      )}
      <a
        href={url}
        className={cn(
          'inline-flex min-h-12 w-full items-center justify-center rounded-[14px] px-5 text-[15px] font-[680]',
          wide ? 'border border-line bg-surface text-ink' : 'bg-ink text-paper hover:opacity-90',
        )}
      >
        Open wallet
      </a>
      {!wide && (
        <button type="button" onClick={() => setShowQr((v) => !v)} className="min-h-11 text-[14px] font-[650] text-muted underline underline-offset-4 hover:text-ink">
          {showQr ? 'Hide the QR code' : 'Wallet on another phone? Show a QR code'}
        </button>
      )}
      <p className="text-center text-[12.5px] text-muted">
        {wallet === 'eudi' ? 'For the EU Digital Identity Wallet.' : 'For wallets such as Paradym or Procivis One.'} The identity must be an EU test identity.
      </p>
    </div>
  )
}

function useQr(text: string | null): string | null {
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (!text) return
    let live = true
    setSrc(null)
    QRCode.toDataURL(text, { margin: 1, width: 440, errorCorrectionLevel: 'M', color: { dark: '#0C0C0D', light: '#FFFFFF' } })
      .then((d) => live && setSrc(d))
      .catch(() => live && setSrc(null))
    return () => {
      live = false
    }
  }, [text])
  return src
}

function ScreenSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col gap-4" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-11 w-40" />
      <Skeleton className="h-72 w-full rounded-[20px]" />
    </div>
  )
}
