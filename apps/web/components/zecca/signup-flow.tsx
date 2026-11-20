'use client'
// Sign-up (UI.md §5.2): welcome and email, handle and name (business switch), one approval, done.
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AtSign, Check, Circle, LoaderCircle } from 'lucide-react'
import { formatUsd, type User } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { isApiError } from '@/lib/api'
import { sessionStore } from '@/lib/session'
import { signedUpUser } from '@/lib/signup'
import { signAndSubmit } from '@/lib/wallet/sign-and-submit'
import { cn } from '@/lib/cn'
import { Amount } from './amount'
import { ArchesProgress } from './arches'
import { Button, Skeleton } from './bits'
import { Logo } from './wordmark'

type Step = 'resume' | 'welcome' | 'handle' | 'approve' | 'done'
const EXPECTED_MS = 7000
const TICKS = ['Creating your account', 'Opening your private balance', 'Adding your demo credit'] as const

export const suggestHandle = (email: string) =>
  email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 20)

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name

function Field({ label, id, children, help, helpTone }: { label: string; id: string; children: React.ReactNode; help?: React.ReactNode; helpTone?: 'in' | 'alert' | 'muted' }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[14px] font-[650] text-ink">
        {label}
      </label>
      {children}
      <p id={`${id}-help`} className={cn('min-h-5 text-[13.5px]', helpTone === 'in' ? 'text-in' : helpTone === 'alert' ? 'text-alert' : 'text-muted')} aria-live="polite">
        {help}
      </p>
    </div>
  )
}

const inputCls =
  'h-12 w-full rounded-[14px] border border-line bg-surface px-4 text-[16px] text-ink placeholder:text-muted/80 outline-none transition-colors focus-visible:border-ink/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brass)] aria-[invalid=true]:border-alert'

export function SignupFlow({ business = false, homeHref = '/app', onFinished }: { business?: boolean; homeHref?: string; /** Replaces the navigation at the end (e.g. /merchant switches to the till in place). */ onFinished?: (user: User) => void }) {
  const { api, config, configError, reloadConfig, signIn, getSigner, signOut } = useApp()
  const router = useRouter()
  const [step, setStep] = useState<Step>('welcome')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [handle, setHandle] = useState('')
  const [availability, setAvailability] = useState<{ handle: string; available: boolean; reason?: string } | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [isBusiness, setIsBusiness] = useState(business)
  const [businessName, setBusinessName] = useState('')
  const [run, setRun] = useState<'idle' | 'running' | 'done' | 'failed'>('idle')
  const [ticked, setTicked] = useState(0)
  const [user, setUser] = useState<User | null>(null)
  const [balanceMinor, setBalanceMinor] = useState<number | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  // Arrived with a session but no user (came back mid sign-up). If the server already finished it, for example the
  // tab was reloaded during the approval, go straight in; otherwise pick up at the handle step. Once, on arrival.
  useEffect(() => {
    const s = sessionStore().get()
    if (!s || s.user) return
    let live = true
    setStep('resume')
    signedUpUser(api).then((u) => {
      if (!live) return
      if (u) enter(u)
      else setStep('handle')
    })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    heading.current?.focus()
  }, [step])

  // Live handle availability, debounced.
  useEffect(() => {
    if (step !== 'handle' || !handle) {
      setAvailability(null)
      return
    }
    const h = handle
    const t = setTimeout(() => {
      api
        .call('handleAvailable', { query: { handle: h } })
        .then((r) => setAvailability({ handle: h, ...r }))
        .catch(() => setAvailability(null))
    }, 280)
    return () => clearTimeout(t)
  }, [api, handle, step])

  function finish(u: User) {
    if (onFinished) onFinished(u)
    else router.replace(u.role.includes('merchant') && business ? '/merchant' : homeHref)
  }

  /** Sign-up already finished on the server: keep the user in the session and go in. */
  function enter(u: User) {
    sessionStore().update({ user: u })
    finish(u)
  }

  /** Start again at the welcome step, for a session that cannot approve (key gone, another account). */
  async function onSignOut() {
    await signOut().catch(() => {})
    setError('')
    setRun('idle')
    setStep('welcome')
  }

  async function onWelcome(method: 'email' | 'google' = 'email') {
    setError('')
    setBusy(true)
    try {
      const r = await signIn({ email, method })
      if (r.user) {
        finish(r.user)
        return
      }
      if (!handle && email) setHandle(suggestHandle(email))
      setStep('handle')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.')
    } finally {
      setBusy(false)
    }
  }

  async function onApprove() {
    const s = sessionStore().get()
    if (!s) {
      setStep('welcome')
      return
    }
    setError('')
    setRun('running')
    setTicked(0)
    const started = performance.now()
    const tick = setInterval(() => {
      const t = (performance.now() - started) / EXPECTED_MS
      setTicked(t > 0.6 ? 2 : t > 0.25 ? 1 : 0)
    }, 200)
    try {
      const prepared = await api.call('onboardingPrepare', {
        body: {
          address: s.address,
          publicKey: s.publicKey,
          handle,
          displayName: displayName.trim(),
          role: isBusiness ? 'merchant' : 'user',
          ...(isBusiness ? { businessName: businessName.trim() } : {}),
          ...(s.email ? { email: s.email } : {}),
        },
      })
      const signer = await getSigner()
      const res = await signAndSubmit(api, signer, prepared)
      const me = res.user ?? (await api.call('me'))
      sessionStore().update({ user: me })
      setUser(me)
      const bal = await api.call('balance').catch(() => null)
      setBalanceMinor(bal ? bal.availableMinor + bal.pendingMinor : null)
      clearInterval(tick)
      setTicked(3)
      setRun('done')
      setTimeout(() => setStep('done'), 900)
    } catch (e) {
      clearInterval(tick)
      const signedUp = isApiError(e) && e.code === 'already_signed_up' ? await signedUpUser(api) : null
      if (signedUp) return enter(signedUp)
      setRun('failed')
      if (isApiError(e) && e.code === 'handle_taken') {
        setStep('handle')
        setAvailability({ handle, available: false, reason: 'Taken, try another.' })
        return
      }
      setError(e instanceof Error && e.message ? e.message : 'Something went wrong. Try again.')
    }
  }

  const handleOk = availability?.handle === handle && availability.available
  const canContinue = handleOk && displayName.trim().length > 0 && (!isBusiness || businessName.trim().length > 0)
  const mock = config?.signerMode === 'mock'
  const google = config?.signerMode === 'privy' && config.features.googleLogin

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-[440px] flex-col px-5 pb-10 pt-6 lg:max-w-[520px] lg:justify-center">
      <header className="flex items-center justify-between">
        <Logo />
        {(step === 'handle' || step === 'approve') && (
          <span className="label-caps text-muted" aria-label={`Step ${step === 'handle' ? 2 : 3} of 3`}>
            {step === 'handle' ? '2' : '3'} / 3
          </span>
        )}
      </header>

      <main className="flex flex-1 flex-col justify-center py-8 lg:my-10 lg:flex-none lg:rounded-[28px] lg:border lg:border-[color-mix(in_srgb,var(--ink)_8%,transparent)] lg:bg-[color-mix(in_srgb,var(--surface)_72%,transparent)] lg:px-10 lg:py-10 lg:shadow-[var(--shadow-float)] lg:backdrop-blur-md">
        {step === 'resume' && (
          <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="mt-6 h-12 w-full rounded-[14px]" />
          </div>
        )}

        {step === 'welcome' && (
          <form
            className="flex flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              onWelcome('email')
            }}
          >
            <h1 ref={heading} tabIndex={-1} className="text-[34px] font-[760] leading-[1.08] tracking-[-0.035em] outline-none">
              {business ? 'Open your business account' : 'Welcome to Zecca'}
            </h1>
            <p className="mt-3 text-[16px] text-muted">{business ? 'Take payments with a tap. One approval and you are set.' : 'Money that moves like a message. Private by default.'}</p>
            {!config ? (
              <div className="mt-8 flex flex-col gap-3" aria-busy={!configError}>
                {configError ? (
                  <div role="alert" className="flex flex-col gap-3">
                    <p className="text-[15px] text-ink">{configError.message}</p>
                    <Button variant="secondary" onClick={reloadConfig}>
                      Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    <Skeleton className="h-5 w-16" />
                    <Skeleton className="h-12 w-full rounded-[14px]" />
                    <Skeleton className="mt-6 h-12 w-full rounded-[14px]" />
                  </>
                )}
              </div>
            ) : (
              <>
            <div className="mt-8 flex flex-col gap-3">
              {google && (
                <Button variant="secondary" onClick={() => onWelcome('google')} disabled={busy || !config}>
                  <GoogleMark /> Continue with Google
                </Button>
              )}
              {mock ? (
                <Field label="Email" id="email">
                  <input id="email" className={inputCls} type="email" inputMode="email" autoComplete="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-describedby="email-help" />
                </Field>
              ) : null}
              <Button type="submit" disabled={busy || !config || (mock && !/^\S+@\S+\.\S+$/.test(email))}>
                {busy ? <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden="true" /> : null}
                {mock ? 'Continue' : 'Continue with email'}
              </Button>
              {error && (
                <p className="text-[14px] text-alert" role="alert">
                  {error}
                </p>
              )}
            </div>
            {mock && <p className="mt-8 text-center text-[12px] text-muted">Test sign-in. No code is sent in this mode.</p>}
              </>
            )}
          </form>
        )}

        {step === 'handle' && (
          <form
            className="flex flex-col"
            onSubmit={(e) => {
              e.preventDefault()
              if (canContinue) setStep('approve')
            }}
          >
            <h1 ref={heading} tabIndex={-1} className="text-[30px] font-[760] leading-[1.1] tracking-[-0.03em] outline-none">
              Pick your handle
            </h1>
            <p className="mt-2 text-[15px] text-muted">People pay you with it.</p>
            <div className="mt-7 flex flex-col gap-2">
              <Field
                label="Handle"
                id="handle"
                help={!handle ? 'Lowercase letters, digits and _.' : availability?.handle === handle ? (availability.available ? <><Check className="mr-1 inline size-4 align-[-3px]" aria-hidden="true" />@{handle} is yours</> : availability.reason ?? 'Taken, try another.') : 'Checking…'}
                helpTone={availability?.handle === handle ? (availability.available ? 'in' : 'alert') : 'muted'}
              >
                <div className="relative">
                  <AtSign className="pointer-events-none absolute left-3.5 top-1/2 size-[18px] -translate-y-1/2 text-muted" aria-hidden="true" />
                  <input
                    id="handle"
                    className={cn(inputCls, 'pl-10')}
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    maxLength={20}
                    value={handle}
                    onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                    aria-describedby="handle-help"
                    aria-invalid={availability?.handle === handle && !availability.available}
                  />
                </div>
              </Field>
              <Field label="Your name" id="name">
                <input id="name" className={inputCls} autoComplete="name" maxLength={60} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Ana Ferri" />
              </Field>
              <label className="flex min-h-12 cursor-pointer items-center justify-between gap-4 rounded-[14px] border border-line bg-surface px-4">
                <span className="text-[15px] font-[600]">I'm setting up a business</span>
                <input type="checkbox" role="switch" checked={isBusiness} onChange={(e) => setIsBusiness(e.target.checked)} className="peer sr-only" />
                <span aria-hidden="true" className="relative h-7 w-12 shrink-0 rounded-full bg-line transition-colors peer-checked:bg-ink peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--brass)] after:absolute after:left-1 after:top-1 after:size-5 after:rounded-full after:bg-surface after:shadow after:transition-transform peer-checked:after:translate-x-5" />
              </label>
              {isBusiness && (
                <div className="mt-3">
                  <Field label="Business name" id="business">
                    <input id="business" className={inputCls} autoComplete="organization" maxLength={60} value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Caffè Bruno" />
                  </Field>
                </div>
              )}
              <Button type="submit" className="mt-3" disabled={!canContinue}>
                Continue
              </Button>
              <Button variant="ghost" onClick={onSignOut}>
                Sign out
              </Button>
            </div>
          </form>
        )}

        {step === 'approve' && (
          <section className="flex flex-col">
            <h1 ref={heading} tabIndex={-1} className="text-[30px] font-[760] leading-[1.1] tracking-[-0.03em] outline-none">
              One approval and you're in.
            </h1>
            <p className="mt-2 text-[15px] text-muted">
              @{handle} · {isBusiness ? businessName : displayName}
            </p>
            <ul className="mt-8 flex flex-col gap-3.5" aria-label="Setting up">
              {TICKS.map((t, i) => {
                const done = run !== 'idle' && ticked > i
                const active = run === 'running' && ticked === i
                return (
                  <li key={t} className={cn('flex items-center gap-3 text-[16px] transition-colors duration-200', done ? 'text-ink' : active ? 'text-ink' : 'text-muted')}>
                    <span className={cn('grid size-6 place-items-center rounded-full border transition-colors duration-200', done ? 'border-in bg-in text-paper' : 'border-line')} aria-hidden="true">
                      {done ? <Check className="size-3.5" strokeWidth={3} /> : active ? <Circle className="size-2 fill-current motion-safe:animate-pulse" /> : null}
                    </span>
                    <span>
                      {t}
                      {t === 'Adding your demo credit' && config ? ` (${formatUsd(config.welcomeCreditMinor)})` : ''}
                    </span>
                    <span className="sr-only">{done ? ', done' : active ? ', in progress' : ''}</span>
                  </li>
                )
              })}
            </ul>
            <ArchesProgress state={run} expectedMs={EXPECTED_MS} className="mt-10 h-12 self-center" label="Setting up your account" />
            <p className="sr-only" aria-live="polite">
              {run === 'running' ? TICKS[Math.min(ticked, 2)] : run === 'done' ? 'Your account is ready' : ''}
            </p>
            {error && (
              <p className="mt-6 text-center text-[14px] text-alert" role="alert">
                {error}
              </p>
            )}
            {run === 'idle' || run === 'failed' ? (
              <div className="mt-8 flex flex-col gap-2">
                <Button onClick={onApprove}>{run === 'failed' ? 'Try again' : 'Approve'}</Button>
                <Button variant="ghost" onClick={() => setStep('handle')}>
                  Back
                </Button>
                {run === 'failed' && (
                  <Button variant="ghost" onClick={onSignOut}>
                    Sign out
                  </Button>
                )}
              </div>
            ) : null}
          </section>
        )}

        {step === 'done' && user && (
          <section className="flex flex-col items-center text-center">
            <h1 ref={heading} tabIndex={-1} className="text-[32px] font-[760] leading-[1.1] tracking-[-0.03em] outline-none">
              You're set, {firstName(user.displayName)}.
            </h1>
            <div className="mt-8 flex flex-col items-center">
              <span className="label-caps text-muted">Balance</span>
              <Amount minor={balanceMinor ?? 0} size="hero" className="mt-3" />
              {(balanceMinor ?? 0) > 0 && <span className="mt-3 rounded-full border border-line bg-surface px-3 py-1 text-[13px] font-[600] text-muted">Demo credit</span>}
            </div>
            <Button className="mt-10 w-full" onClick={() => finish(user)}>
              Go to home
            </Button>
          </section>
        )}
      </main>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden="true">
      <path fill="currentColor" d="M21.6 12.23c0-.68-.06-1.36-.18-2.02H12v3.83h5.4a4.62 4.62 0 0 1-2 3.03v2.5h3.24c1.9-1.75 2.96-4.33 2.96-7.34Z" opacity=".9" />
      <path fill="currentColor" d="M12 22c2.7 0 4.98-.9 6.64-2.43l-3.24-2.5c-.9.6-2.05.96-3.4.96-2.6 0-4.82-1.76-5.6-4.13H3.06v2.58A10 10 0 0 0 12 22Z" opacity=".7" />
      <path fill="currentColor" d="M6.4 13.9a6 6 0 0 1 0-3.8V7.52H3.06a10 10 0 0 0 0 8.96L6.4 13.9Z" opacity=".5" />
      <path fill="currentColor" d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.87-2.88A9.63 9.63 0 0 0 12 2a10 10 0 0 0-8.94 5.52L6.4 10.1C7.18 7.74 9.4 5.98 12 5.98Z" opacity=".8" />
    </svg>
  )
}
