'use client';
import { useEffect, useState } from 'react';
import { Wallet } from 'xrpl';
import { encryptSeed, type Secret } from '@/lib/seedvault';
import { getMe, prfKey, prfSupport, savedCredentialId } from '@/lib/passkey';
import { delegateSet, getClient, saveCard, loadCard } from '@/lib/browser';

// Seed is generated, encrypted and kept in this browser only; the server only ever sees the public address.
export default function Onboard() {
  const [userId, setUserId] = useState<string>();
  const [pin, setPin] = useState('');
  const [needPin, setNeedPin] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const step = (s: string) => setLog((l) => [...l, s]);

  useEffect(() => { if (prfSupport() === false) setNeedPin(true); }, []); // passkey can't encrypt here (e.g. Bitwarden): PIN from the start
  useEffect(() => { getMe().then((u) => (u ? setUserId(u.id) : (location.href = '/login?next=/onboard'))); }, []);

  async function create() {
    setBusy(true); setErr(''); setLog([]);
    try {
      if (loadCard() && !confirm('Une carte existe déjà dans ce navigateur. La remplacer ? (la seed actuelle sera perdue si non exportée)')) return;
      // Protect the seed with the passkey when the browser supports PRF, else with a PIN.
      let secret: Secret | null = needPin ? pin : await prfKey(savedCredentialId());
      if (!secret) {
        if (pin.length < 6) { setNeedPin(true); setErr('Cette passkey ne peut pas chiffrer la clé sur cet appareil : choisissez un PIN (6 chiffres min.).'); return; }
        secret = pin;
      }
      const wallet = Wallet.generate();
      const vault = await encryptSeed(wallet.seed!, secret);
      saveCard({ address: wallet.address, vault, user: userId });
      step('Compte généré dans le navigateur : ' + wallet.address);
      await (await getClient()).fundWallet(wallet);
      step('Compte financé via le faucet testnet');
      const hash = await delegateSet(wallet, true);
      step('Délégation signée ici et validée : ' + hash.slice(0, 12) + '…');
      const r = await fetch('/api/cards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet.address }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      saveCard({ address: wallet.address, vault, token: j.token, user: userId });
      step('Carte activée');
      location.href = '/card';
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <main>
      <h1>Créer ma carte</h1>
      <div className="box">
        <p className="mut">Un compte XRPL testnet est créé dans ce navigateur. Votre clé reste ici, chiffrée par votre passkey ou, si votre gestionnaire de passkeys ne le permet pas, par un PIN. Vous pouvez révoquer la carte à tout moment.</p>
        {needPin && <input type="password" inputMode="numeric" placeholder="Choisir un PIN (6 chiffres min.)" value={pin} onChange={(e) => setPin(e.target.value)} />}
        <button disabled={busy || !userId} onClick={create}>{busy ? 'En cours…' : 'Créer la carte'}</button>
        <ul className="prog">{log.map((l) => <li key={l} className="done">✓ {l}</li>)}{busy && <li className="now">En cours…</li>}</ul>
        {err && <p className="err">{err}</p>}
      </div>
    </main>
  );
}
