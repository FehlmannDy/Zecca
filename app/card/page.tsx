'use client';
import { useCallback, useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { dropsToXrp } from 'xrpl';
import { delegateSet, getClient, getConfig, loadCard, unlock, type Config, type Stored } from '@/lib/browser';
import { getMe } from '@/lib/passkey';
import TransakMock from '@/components/TransakMock';

export default function Card() {
  const [card, setCard] = useState<Stored | null | undefined>(undefined);
  const [cfg, setCfg] = useState<Config>();
  const [balance, setBalance] = useState<string>('…');
  const [status, setStatus] = useState('active');
  const [qr, setQr] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState('');
  const [seed, setSeed] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (address: string) => {
    const client = await getClient();
    try { setBalance(String(dropsToXrp((await client.request({ command: 'account_info', account: address, ledger_index: 'current' })).result.account_data.Balance))); }
    catch { setBalance('0'); }
  }, []);

  useEffect(() => {
    let on = true;
    (async () => {
      const me = await getMe();
      if (!me) { location.href = '/login?next=/card'; return; }
      const c = loadCard();
      // A card stored by another account on this browser is not ours to show.
      if (!c?.token || (c.user && c.user !== me.id)) { setCard(null); return; }
      setCard(c);
      getConfig().then(setCfg);
      QRCode.toDataURL(c.token, { margin: 0, width: 480 }).then(setQr);
      fetch('/api/cards?token=' + encodeURIComponent(c.token)).then((r) => r.json()).then((j) => j.status && setStatus(j.status));
      // Live balance: subscribe to the account over the browser's own WebSocket (no third party); refetch on every tx.
      const client = await getClient();
      await refresh(c.address);
      await client.request({ command: 'subscribe', accounts: [c.address] });
      client.on('transaction', () => on && refresh(c.address));
    })();
    return () => { on = false; };
  }, [refresh]);

  async function act(fn: () => Promise<void>) {
    setBusy(true); setMsg('');
    try { await fn(); } catch (e) { setMsg((e instanceof Error && e.name === 'OperationError') ? 'PIN incorrect' : (e as Error).message); } finally { setBusy(false); }
  }

  const usesPin = card?.vault.kind !== 'prf';
  const locked = usesPin && !pin; // PIN vaults need the PIN typed; passkey vaults prompt on demand
  const fund = async () => { const w = await unlock(pin); await (await getClient()).fundWallet(w); await refresh(w.address); };
  const exportSeed = () => act(async () => setSeed((await unlock(pin)).seed!));
  const revoke = () => act(async () => {
    if (!confirm('Révoquer la carte ? Plus aucun paiement ne sera possible.')) return;
    await delegateSet(await unlock(pin), false);
    const r = await fetch('/api/cards', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: card!.token }) });
    if (!r.ok) throw new Error((await r.json()).error);
    setStatus('revoked');
  });

  if (card === undefined) return <main />;
  if (!card?.token) return <main><div className="box"><p>Aucune carte sur cet appareil pour votre compte.</p><a href="/onboard">Créer ma carte</a></div></main>;
  const revoked = status === 'revoked';

  return (
    <main>
      <div className={'paycard' + (revoked ? ' revoked' : '')}>
        <span className="brand">ZECCA</span>
        <span className="amount">{balance} XRP</span>
        <div><p className="tag">{revoked ? 'Carte révoquée' : 'Carte active · testnet'}</p><code>{card.address}</code></div>
      </div>
      {!revoked && qr && <div className="box"><p className="mut">Présentez ce QR au terminal</p><div className="qr"><img src={qr} alt="QR de la carte" /></div></div>}
      <div className="box">
        {usesPin && <input type="password" inputMode="numeric" placeholder="PIN (pour les actions ci-dessous)" value={pin} onChange={(e) => setPin(e.target.value)} />}
        <TransakMock disabled={busy || locked} onConfirm={fund} />
        <button className="ghost" disabled={busy || locked} onClick={() => act(async () => { await fund(); setMsg('Rechargé (testnet)'); })}>Recharger (testnet)</button>
        <button className="ghost" disabled={busy || locked} onClick={exportSeed}>Exporter la seed</button>
        {seed && <code>{seed}</code>}
        <button className="danger" disabled={busy || locked || revoked} onClick={revoke}>Révoquer la carte</button>
        {msg && <p className={msg.startsWith('Rechargé') ? 'ok' : 'err'}>{msg}</p>}
        {cfg?.walletEnabled && <p className="mut">Google Wallet : bientôt (phase 4)</p>}
      </div>
    </main>
  );
}
