'use client'
// /dev/passkey: a bare test bench for Privy passkey MFA on XRPL raw_sign. Sign in through the same WalletManager +
// PrivyAdapter as the app (lib/wallet/privy), link a passkey, enrol it, sign a harmless transaction that can never
// be submitted (AccountSet, Sequence 1, LastLedgerSequence 1), and log every step. Driven by
// apps/web/scripts/passkey/run-privy-passkey.mjs with a Chromium virtual authenticator.
// ?timeoutMs=60000 builds a local adapter with that sign timeout instead of the app's (default 15 s).
import { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from '@/lib/app'
import { getPrivy, type PrivyHandle } from '@/lib/wallet/privy'
import {
  enrollPasskeyMfa,
  installPasskeyMfa,
  isPasskeyAvailable,
  linkPasskey,
  passkeyErrorMessage,
  readPasskeyStatus,
  verifyPasskeyNow,
  verifySignedBlob,
  getPrivyClient,
  patchPrivyIframeReady,
  type InstalledPasskeyMfa,
} from '@/lib/passkey'

const DEFAULT_APP_ID = 'cmwp3ayt902ll0il2cu05wx46'

type Entry = { t: string; ms: number; event: string; detail?: unknown }
type ConnectorEl = HTMLElement & { openAndWait(): Promise<{ address: string; publicKey?: string }>; setWalletManager(m: unknown): void }

declare global {
  interface Window {
    __passkeyDev?: { log: Entry[]; lastSign?: { hash: string; verified: boolean; ms: number; prompts: number } }
  }
}

let localHandle: Promise<PrivyHandle> | null = null
function localPrivy(appId: string, timeoutMs: number): Promise<PrivyHandle> {
  localHandle ??= (async () => {
    const [{ WalletManager }, { PrivyAdapter }] = await Promise.all([import('xrpl-connect'), import('@xrpl-commons/xrpl-connect-privy')])
    const adapter = new PrivyAdapter({ appId, redirectUri: `${window.location.origin}/wallet/privy`, timeoutMs })
    const manager = new WalletManager({ adapters: [adapter], network: 'devnet', autoConnect: false })
    return { manager, adapter }
  })()
  return localHandle
}

export function DevPasskey() {
  const { config } = useApp()
  const allowed = process.env.NODE_ENV !== 'production' || !!config?.demoMode || !!config?.features.passkey
  const appId = config?.privyAppId ?? process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? DEFAULT_APP_ID
  const [entries, setEntries] = useState<Entry[]>([])
  const [account, setAccount] = useState<{ address: string; publicKey: string } | null>(null)
  const [busy, setBusy] = useState('')
  const ownConnector = useRef<ConnectorEl | null>(null)
  const handleRef = useRef<Promise<PrivyHandle> | null>(null)
  const mfaRef = useRef<InstalledPasskeyMfa | null>(null)
  const prompts = useRef(0)
  const t0 = useRef(typeof performance !== 'undefined' ? performance.now() : 0)

  const log = useCallback((event: string, detail?: unknown) => {
    const e: Entry = { t: new Date().toISOString(), ms: Math.round(performance.now() - t0.current), event, detail }
    window.__passkeyDev ??= { log: [] }
    window.__passkeyDev.log.push(e)
    setEntries((xs) => [...xs, e])
  }, [])

  const handle = useCallback(() => {
    if (!handleRef.current) {
      const custom = Number(new URLSearchParams(window.location.search).get('timeoutMs'))
      handleRef.current = custom > 0 ? localPrivy(appId, custom) : getPrivy(appId)
    }
    return handleRef.current
  }, [appId])

  const ensureMfa = useCallback(async () => {
    if (mfaRef.current) return mfaRef.current
    const { adapter } = await handle()
    const deadline = Number(new URLSearchParams(window.location.search).get('deadlineMs')) || undefined
    const m = installPasskeyMfa(adapter, deadline ? { deadlineMs: deadline } : {})
    if (!m) throw new Error('Sign in first.')
    m.subscribe((e) => {
      if (e.type === 'prompt') prompts.current += 1
      log(e.type === 'log' ? e.event : `mfa:${e.type}`, e.type === 'done' ? (e.outcome.ok ? { ok: true } : { ok: false, type: e.outcome.error.type, message: e.outcome.error.message }) : e.type === 'log' ? e.detail : undefined)
    })
    mfaRef.current = m
    log('handler:installed')
    return m
  }, [handle, log])

  const afterConnect = useCallback(
    async (a: { address: string; publicKey?: string } | null | undefined) => {
      if (!a?.publicKey) return
      setAccount({ address: a.address, publicKey: a.publicKey })
      log('connected', { address: a.address })
      await ensureMfa()
      const s = await readPasskeyStatus(getPrivyClient((await handle()).adapter))
      log('status', s)
    },
    [ensureMfa, handle, log],
  )

  const booted = useRef(false)
  useEffect(() => {
    if (!allowed || booted.current) return
    booted.current = true
    ;(async () => {
      await import('xrpl-connect')
      const { manager, adapter } = await handle()
      log('iframe-ready-patch', { patched: patchPrivyIframeReady(adapter) })
      manager.on('error', (e: unknown) => log('wallet:error', { message: (e as Error)?.message, code: (e as { code?: string })?.code }))
      if (config?.signerMode !== 'privy' && ownConnector.current) ownConnector.current.setWalletManager(manager)
      log('available', { platformAuthenticator: await isPasskeyAvailable(), origin: window.location.origin })
      const a = manager.account ?? (await manager.reconnect().catch(() => null))
      await afterConnect(a as never)
    })().catch((e) => log('error', { message: (e as Error).message }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed])

  async function step(name: string, fn: () => Promise<unknown>) {
    setBusy(name)
    log(`${name}:start`)
    const started = performance.now()
    try {
      const out = await fn()
      log(`${name}:ok`, { ms: Math.round(performance.now() - started), ...(out && typeof out === 'object' ? out : {}) })
    } catch (e) {
      const err = e as { message?: string; code?: string; name?: string; type?: string; originalError?: { message?: string; type?: string } }
      log(`${name}:error`, { ms: Math.round(performance.now() - started), message: err?.message, code: err?.code, name: err?.name, type: err?.type, original: err?.originalError?.message, originalType: err?.originalError?.type, friendly: passkeyErrorMessage(e) })
    } finally {
      setBusy('')
    }
  }

  const client = async () => getPrivyClient((await handle()).adapter)

  if (!allowed) return <main className="p-6 text-[15px]">Not available.</main>

  return (
    <main className="mx-auto max-w-[760px] p-4 font-mono text-[13px]">
      <h1 className="mb-2 text-[18px] font-[700]">Passkey MFA test bench</h1>
      <p className="mb-4 text-muted">Signs a never-valid AccountSet (Sequence 1, LastLedgerSequence 1). Nothing is submitted.</p>
      <p className="mb-4" data-testid="account">{account ? `Signed in: ${account.address}` : 'Not signed in'}</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {[
          ['Sign in', () => step('signin', async () => {
            const el = (document.querySelector('xrpl-wallet-connector') as ConnectorEl | null) ?? ownConnector.current
            if (!el) throw new Error('No connector')
            const a = await el.openAndWait()
            await afterConnect(a)
            return { address: a.address }
          })],
          ['Link passkey', () => step('link', async () => {
            await ensureMfa()
            const r = await linkPasskey(await client())
            return { credentialId: r.credentialId }
          })],
          ['Enroll as MFA', () => step('enroll', async () => {
            await ensureMfa()
            return enrollPasskeyMfa(await client())
          })],
          ['Verify now', () => step('verify', async () => {
            await ensureMfa()
            await verifyPasskeyNow(await client())
          })],
          ['Status', () => step('status', async () => readPasskeyStatus(await client()))],
          ['Sign test transaction', () => step('sign', async () => {
            await ensureMfa()
            const { manager } = await handle()
            const a = manager.account
            if (!a?.publicKey) throw new Error('Sign in first.')
            const before = prompts.current
            const started = performance.now()
            const signed = (await manager.sign({ TransactionType: 'AccountSet', Account: a.address, Fee: '12', Sequence: 1, LastLedgerSequence: 1 } as never)) as unknown as { tx_blob: string; hash: string }
            const ms = Math.round(performance.now() - started)
            const v = verifySignedBlob(signed.tx_blob, a.publicKey)
            const result = { hash: signed.hash, verified: v.ok, ms, prompts: prompts.current - before }
            window.__passkeyDev!.lastSign = result
            return result
          })],
          ['Sign out', () => step('signout', async () => {
            const { manager } = await handle()
            await manager.disconnect()
            setAccount(null)
          })],
        ].map(([label, fn]) => (
          <button key={label as string} type="button" disabled={!!busy} onClick={fn as () => void} className="rounded-[10px] border border-line px-3 py-2 disabled:opacity-50">
            {label as string}
          </button>
        ))}
      </div>
      {config?.signerMode !== 'privy' && <xrpl-wallet-connector ref={ownConnector as never} />}
      <ol className="flex flex-col gap-1" data-testid="log">
        {entries.map((e, i) => (
          <li key={i} className="break-all">
            <span className="text-muted">+{e.ms}ms</span> {e.event} {e.detail !== undefined ? JSON.stringify(e.detail) : ''}
          </li>
        ))}
      </ol>
    </main>
  )
}
