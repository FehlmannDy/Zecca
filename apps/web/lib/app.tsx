'use client'
// App-wide context: the API client, GET /v1/config (features drive what is shown), and the wallet
// (mock or Privy signer, chosen by config.signerMode).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { PublicConfig, User } from '@zecca/contracts'
import { createApi, DEFAULT_API_ORIGIN, isApiError, ZeccaApiError, type ApiClient } from './api'
import { sessionStore } from './session'
import { browserStorage, type WalletSigner } from './wallet/types'
import { mockSignerForEmail, signInMock } from './wallet/mock'
import { getPrivy, privyAccessToken, privySigner } from './wallet/privy'
import { installPasskeyMfa } from './passkey/install'

export const API_ORIGIN = process.env.NEXT_PUBLIC_API_ORIGIN || DEFAULT_API_ORIGIN
export const API_MOCK = process.env.NEXT_PUBLIC_API_MOCK === '1'

type SignInResult = { user?: User }

type AppContext = {
  api: ApiClient
  config: PublicConfig | null
  configError: ZeccaApiError | null
  reloadConfig: () => void
  /** Sign in (mock: with the email; privy: opens Privy's email login, or Google). */
  signIn: (opts: { email?: string; method?: 'email' | 'google' }) => Promise<SignInResult>
  /** Finish a Privy login that came back through /wallet/privy (redirect flows such as Google). */
  completePrivyRedirect: () => Promise<SignInResult>
  /** The current user's signer. Throws an English message when it is not available. */
  getSigner: () => Promise<WalletSigner>
  signOut: () => Promise<void>
}

const Ctx = createContext<AppContext | null>(null)

let mockReady: Promise<unknown> | null = null
/** Resolves once the mock API's service worker is running (immediately when not mocking). */
export function whenMockReady() {
  if (!API_MOCK || typeof window === 'undefined') return Promise.resolve()
  mockReady ??= import('../mocks/browser').then((m) => m.startMockWorker(API_ORIGIN))
  return mockReady
}

/** The <xrpl-wallet-connector> element, once mounted (privy mode). Signing fails closed without it. */
let connectorEl: (HTMLElement & { open(): Promise<void>; openAndWait(): Promise<{ address: string; publicKey?: string }>; setWalletManager(m: unknown): void }) | null = null

export function AppProvider({ children }: { children: ReactNode }) {
  const api = useMemo(
    () =>
      createApi({
        origin: API_ORIGIN,
        getToken: () => sessionStore().get()?.token,
        onUnauthorized: () => sessionStore().clear(),
        fetch: async (...args) => {
          await whenMockReady()
          return fetch(...args)
        },
      }),
    [],
  )
  const [config, setConfig] = useState<PublicConfig | null>(null)
  const [configError, setConfigError] = useState<ZeccaApiError | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setConfigError(null)
    api
      .call('config')
      .then((c) => live && setConfig(c))
      .catch((e) => live && setConfigError(isApiError(e) ? e : new ZeccaApiError(0, { code: 'internal', message: 'Something went wrong. Try again.' })))
    return () => {
      live = false
    }
  }, [api, attempt])

  const configRef = useRef(config)
  configRef.current = config

  const openSession = useCallback(
    async (address: string, publicKey: string, privyToken: string) => {
      const res = await api.call('authSession', { body: { privyToken, address, publicKey } })
      sessionStore().set({ token: res.token, address, publicKey, signer: 'privy', user: res.user })
      return { user: res.user }
    },
    [api],
  )

  const signIn = useCallback<AppContext['signIn']>(
    async ({ email, method = 'email' }) => {
      const cfg = configRef.current
      if (!cfg) throw new Error('Zecca is still loading. Try again in a moment.')
      if (cfg.signerMode === 'mock') {
        if (!email) throw new Error('Enter your email.')
        const r = await signInMock({ api, email, storage: browserStorage() })
        sessionStore().set({ token: r.token, address: r.signer.address, publicKey: r.signer.publicKey, signer: 'mock', email: email.trim().toLowerCase(), user: r.user })
        return { user: r.user }
      }
      if (!cfg.privyAppId) throw new Error('Sign-in is not configured.')
      const { manager, adapter } = await getPrivy(cfg.privyAppId)
      let account: { address: string; publicKey?: string }
      if (method === 'google') account = await manager.connect('privy', { loginMethod: 'google' } as never)
      else {
        if (!connectorEl) throw new Error('Sign-in is still loading. Try again in a moment.')
        account = await connectorEl.openAndWait()
      }
      if (!account.publicKey) throw new Error("We couldn't finish signing you in. Try again.")
      return openSession(account.address, account.publicKey, await privyAccessToken(adapter))
    },
    [api, openSession],
  )

  const completePrivyRedirect = useCallback(async () => {
    const cfg = configRef.current
    if (!cfg?.privyAppId) return {}
    const { manager, adapter } = await getPrivy(cfg.privyAppId)
    const account = manager.account ?? (await manager.reconnect())
    if (!account?.publicKey) throw new Error("We couldn't finish signing you in. Try again.")
    return openSession(account.address, account.publicKey, await privyAccessToken(adapter))
  }, [openSession])

  const getSigner = useCallback(async (): Promise<WalletSigner> => {
    const s = sessionStore().get()
    if (!s) throw new Error('Sign in again to approve.')
    if (s.signer === 'mock') {
      if (!s.email) throw new Error('Sign in again to approve.')
      const signer = mockSignerForEmail(s.email, browserStorage())
      if (signer.address !== s.address) throw new Error('Sign in again to approve.')
      return signer
    }
    const cfg = configRef.current
    if (!cfg?.privyAppId) throw new Error('Sign-in is not configured.')
    if (!connectorEl) throw new Error('Approvals are still loading. Try again in a moment.')
    const { manager, adapter } = await getPrivy(cfg.privyAppId)
    if (!manager.account) await manager.reconnect()
    // Answers Privy's passkey check (Face ID) when the user enrolled one; does nothing otherwise.
    installPasskeyMfa(adapter)
    const signer = privySigner(manager)
    if (signer.address !== s.address) throw new Error('Sign in again to approve.')
    return signer
  }, [])

  const signOut = useCallback(async () => {
    const s = sessionStore().get()
    sessionStore().clear()
    const cfg = configRef.current
    if (s?.signer === 'privy' && cfg?.privyAppId) {
      const { manager } = await getPrivy(cfg.privyAppId)
      await manager.disconnect().catch(() => {})
    }
  }, [])

  const value = useMemo<AppContext>(
    () => ({ api, config, configError, reloadConfig: () => setAttempt((n) => n + 1), signIn, completePrivyRedirect, getSigner, signOut }),
    [api, config, configError, signIn, completePrivyRedirect, getSigner, signOut],
  )
  return (
    <Ctx.Provider value={value}>
      {children}
      {config?.signerMode === 'privy' && config.privyAppId && <PrivyConnector appId={config.privyAppId} />}
    </Ctx.Provider>
  )
}

/** Mounts <xrpl-wallet-connector> and hands it the manager, as in the probe. Client only. */
function PrivyConnector({ appId }: { appId: string }) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    let live = true
    ;(async () => {
      await import('xrpl-connect') // registers the custom element
      const { manager } = await getPrivy(appId)
      const el = ref.current as typeof connectorEl
      if (!live || !el) return
      el.setWalletManager(manager)
      connectorEl = el
      await manager.reconnect().catch(() => null)
    })()
    return () => {
      live = false
      connectorEl = null
    }
  }, [appId])
  return <xrpl-wallet-connector ref={ref} />
}

export function useApp(): AppContext {
  const c = useContext(Ctx)
  if (!c) throw new Error('useApp outside AppProvider')
  return c
}
export const useApi = () => useApp().api
export function useConfig() {
  const { config, configError, reloadConfig } = useApp()
  return { config, error: configError, reload: reloadConfig, loading: !config && !configError }
}
