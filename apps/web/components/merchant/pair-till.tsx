'use client'
// Pair a till (/merchant/pair): a single-use code, as a QR code and in large type, that Zecca Till (the merchant's
// Android app, apps/merchant-till) scans or types to take charges for this business. Below it, the paired tills with "Unpair".
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft, Check, Download, Smartphone } from 'lucide-react'
import { isApiError } from '@/lib/api'
import { useApp } from '@/lib/app'
import { useSession } from '@/lib/session'
import { Button, EmptyState, Skeleton } from '@/components/zecca/bits'
import { GlassRoot, Panel } from '@/components/zecca/glass'
import { SpaceSwitch } from '@/components/zecca/space-switch'
import { hasSpaceSwitch } from '@/components/zecca/space-switch-model'
import { useHydrated } from '@/components/zecca/user-shell'
import { Logo } from '@/components/zecca/wordmark'
import { TILL_APK_URL, formatCode, newTillAfter, tillSubtitle, type PairingCode, type TillView } from '@/app/merchant/pair/pair-model'
import { QrCode } from './qr-code'
import { expiresIn } from './till-model'
import { useInterval } from './use-request-stream'

const POLL_MS = 3000
const message = (e: unknown, fallback: string) => (isApiError(e) || e instanceof Error ? e.message : fallback)

export function PairTill() {
  const session = useSession()
  const hydrated = useHydrated()
  const router = useRouter()
  const user = session?.user
  useEffect(() => {
    if (hydrated && !user) router.replace('/merchant')
  }, [hydrated, user, router])
  if (!hydrated || !user) return null
  const isMerchant = user.role.includes('merchant')
  const name = user.merchant?.businessName ?? user.displayName

  return (
    <GlassRoot>
      <div className="mx-auto w-full max-w-[1120px] px-4 pb-16 pt-[max(16px,env(safe-area-inset-top))] lg:px-8">
        <header className="flex h-14 items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/merchant" aria-label="Business home" className="inline-flex min-h-11 items-center rounded-[10px]">
              <Logo className={hasSpaceSwitch(user) ? 'max-sm:[&>span]:hidden' : undefined} />
            </Link>
            <SpaceSwitch user={user} />
          </div>
          <Link href="/merchant" className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface/70 px-4 text-[13.5px] font-[650]">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back
          </Link>
        </header>
        <main className="pt-4">
          <div className="mb-5">
            <p className="label-caps text-muted">Tills</p>
            <h1 className="mt-2 text-[28px] font-[760] leading-tight tracking-[-0.035em] lg:text-[34px]">{name}</h1>
          </div>
          {isMerchant ? (
            <PairScreen />
          ) : (
            <Panel className="mx-auto mt-10 max-w-[520px]" title="This account is personal">
              <p className="text-[15px] text-muted">Business accounts are opened at sign-up, with the business switch on.</p>
            </Panel>
          )}
        </main>
      </div>
    </GlassRoot>
  )
}

function PairScreen() {
  const { api } = useApp()
  const [code, setCode] = useState<PairingCode | null>(null)
  const [codeError, setCodeError] = useState('')
  const [loadingCode, setLoadingCode] = useState(false)
  const [list, setList] = useState<TillView[] | null>(null)
  const [listError, setListError] = useState('')
  const [paired, setPaired] = useState<TillView | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const known = useRef<TillView[] | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { items } = await api.call('tillList')
      setListError('')
      setList(items)
      if (known.current) {
        const fresh = newTillAfter(known.current, items)
        if (fresh) {
          setPaired(fresh)
          setCode(null)
        }
      }
      known.current = items
    } catch (e) {
      setListError(message(e, "We couldn't load your tills. Try again."))
    }
  }, [api])

  const showCode = useCallback(async () => {
    setLoadingCode(true)
    setCodeError('')
    setPaired(null)
    try {
      setCode(await api.call('tillPairingCreate'))
      setNow(Date.now())
    } catch (e) {
      setCode(null)
      setCodeError(message(e, "We couldn't make a code. Try again."))
    } finally {
      setLoadingCode(false)
    }
  }, [api])

  // Once per visit (React's strict mode runs effects twice; a second code would replace the first one on screen).
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void refresh().then(showCode)
  }, [refresh, showCode])

  const expired = !!code && Date.parse(code.expiresAt) <= now
  const live = !!code && !expired
  useInterval(() => setNow(Date.now()), 1000, live)
  // While a code is on screen, watch for the till that uses it.
  useInterval(() => void refresh(), POLL_MS, live)

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-start">
      <Panel title="Pair a till" subtitle="Zecca Till turns an Android phone into a till that charges for this business.">
        <div className="flex flex-col items-center pb-2 pt-3 text-center">
          {paired ? (
            <div className="flex flex-col items-center py-6" role="status">
              <span className="grid size-16 place-items-center rounded-full border border-[var(--in)] text-[var(--in)]">
                <Check className="size-8" aria-hidden="true" />
              </span>
              <p className="mt-5 text-[20px] font-[720] tracking-[-0.02em]">Paired with {paired.name}.</p>
              <p className="mt-1.5 text-[15px] text-muted">It can take charges now.</p>
              <Button variant="secondary" className="mt-6 min-w-[220px]" onClick={showCode}>
                Pair another till
              </Button>
            </div>
          ) : code && !expired ? (
            <>
              <QrCode value={code.qrPayload} label="Pairing code for Zecca Till" className="w-full max-w-[260px] border border-line" />
              <p className="tabular mt-6 font-[760] leading-none tracking-[0.14em] text-[clamp(34px,9vw,44px)]" aria-label={`Code ${code.pairingCode.split('').join(' ')}`}>
                {formatCode(code.pairingCode)}
              </p>
              <p className="mt-4 max-w-[34ch] text-[15.5px] font-[600]">Open Zecca Till on the merchant phone and scan this code.</p>
              <p className="mt-1.5 text-[13.5px] text-muted">
                No camera? Type the code in the app. <span className="whitespace-nowrap">Expires in <span className="tabular">{expiresIn(code.expiresAt, now)}</span>.</span>
              </p>
            </>
          ) : loadingCode && !code ? (
            <>
              <Skeleton className="aspect-square w-full max-w-[260px] rounded-[20px]" />
              <Skeleton className="mt-6 h-10 w-[220px]" />
            </>
          ) : (
            <div className="flex flex-col items-center py-6">
              <p className="text-[17px] font-[650]" role={codeError ? 'alert' : 'status'}>
                {codeError || 'This code has expired.'}
              </p>
              <Button className="mt-6 min-w-[220px]" onClick={showCode} disabled={loadingCode} aria-busy={loadingCode}>
                Show a new code
              </Button>
            </div>
          )}
        </div>
        <a
          href={TILL_APK_URL}
          className="mt-4 flex min-h-11 items-center justify-center gap-2 rounded-[14px] text-[14px] font-[650] text-muted underline decoration-line underline-offset-4 hover:text-ink"
        >
          <Download className="size-4" aria-hidden="true" />
          No app yet? Get Zecca Till for Android
        </a>
      </Panel>

      <Panel title="Paired tills">
        {list === null ? (
          listError ? (
            <ListProblem text={listError} onRetry={refresh} />
          ) : (
            <div className="flex flex-col gap-3 pt-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )
        ) : list.length === 0 ? (
          <EmptyState title="No till paired yet." />
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {list.map((t) => (
              <TillRow key={t.id} till={t} now={now} onUnpair={async () => {
                await api.call('tillRevoke', { params: { id: t.id } })
                known.current = (known.current ?? []).filter((x) => x.id !== t.id)
                setList((l) => (l ?? []).filter((x) => x.id !== t.id))
                setPaired((p) => (p?.id === t.id ? null : p))
              }} />
            ))}
          </ul>
        )}
        {list !== null && listError && <p className="mt-3 text-[13.5px] text-muted">{listError}</p>}
      </Panel>
    </div>
  )
}

function TillRow({ till, now, onUnpair }: { till: TillView; now: number; onUnpair: () => Promise<void> }) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!confirm) return
    const id = setTimeout(() => setConfirm(false), 4000)
    return () => clearTimeout(id)
  }, [confirm])
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="grid size-11 shrink-0 place-items-center rounded-[12px] border border-line bg-surface" aria-hidden="true">
        <Smartphone className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-[680]">{till.name}</span>
        <span className="block truncate text-[13px] text-muted">{error || tillSubtitle(till, now)}</span>
      </span>
      <Button
        variant={confirm ? 'danger' : 'secondary'}
        className="min-h-11 shrink-0 px-4 text-[14px]"
        disabled={busy}
        aria-busy={busy}
        onClick={async () => {
          if (!confirm) return setConfirm(true)
          setBusy(true)
          setError('')
          try {
            await onUnpair()
          } catch (e) {
            setError(message(e, "We couldn't unpair it. Try again."))
            setBusy(false)
            setConfirm(false)
          }
        }}
      >
        {confirm ? `Unpair ${till.name}?` : 'Unpair'}
      </Button>
    </li>
  )
}

function ListProblem({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-center">
      <p className="text-[15px] text-muted" role="alert">
        {text}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
