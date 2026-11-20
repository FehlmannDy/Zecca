'use client';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { loginWithPasskey, registerPasskey } from '@/lib/passkey';

function Login() {
  const next = useSearchParams().get('next') ?? '/card';
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true); setErr('');
    try { await fn(); location.href = next.startsWith('/') ? next : '/card'; }
    catch (e) { console.error('passkey error', e); setErr(`${(e as Error).name}: ${(e as Error).message}`); setBusy(false); }
  };
  return (
    <main>
      <h1>Connexion</h1>
      <div className="box">
        <h2>J&apos;ai déjà un compte</h2>
        <button disabled={busy} onClick={run(loginWithPasskey)}>Se connecter avec ma passkey</button>
      </div>
      <div className="box">
        <h2>Nouveau sur Zecca</h2>
        <p className="mut">Une passkey remplace le mot de passe : Face ID, empreinte ou code de votre appareil.</p>
        <input placeholder="Votre prénom" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="ghost" disabled={busy || !name.trim()} onClick={run(() => registerPasskey(name))}>Créer un compte avec une passkey</button>
      </div>
      {err && <p className="err">{err}</p>}
    </main>
  );
}
export default function Page() { return <Suspense><Login /></Suspense>; }
