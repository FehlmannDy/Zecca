'use client';
import { useRef, useState } from 'react';

// SIMULATION of a fiat on-ramp (Transak-style checkout). No network call, no real payment.
// On confirm we just fund the testnet account via the faucet (done by the parent).
const RATE_CHF_PER_XRP = 2; // fake rate for the demo
export default function TransakMock({ onConfirm, disabled }: { onConfirm: () => Promise<void>; disabled?: boolean }) {
  const dlg = useRef<HTMLDialogElement>(null);
  const [chf, setChf] = useState('50');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function pay() {
    setBusy(true);
    try { await new Promise((r) => setTimeout(r, 900)); await onConfirm(); setDone(true); } finally { setBusy(false); }
  }
  return (
    <>
      <button className="ghost" disabled={disabled} onClick={() => { setDone(false); dlg.current?.showModal(); }}>Acheter des XRP par carte (simulation)</button>
      <dialog ref={dlg} className="sheet">
        <div style={{ display: 'grid', gap: 12 }}>
          <h2>Acheter des XRP</h2>
          <p className="notice">Simulation d&apos;un service de paiement (type Transak). Aucun paiement réel : le testnet crédite des XRP de test.</p>
          {done ? <p className="ok">Achat simulé terminé. Le solde se met à jour.</p> : <>
            <label className="mut">Montant en CHF</label>
            <input inputMode="decimal" value={chf} onChange={(e) => setChf(e.target.value)} />
            <p className="mut">≈ {(Number(chf) / RATE_CHF_PER_XRP || 0).toFixed(2)} XRP au taux fictif de {RATE_CHF_PER_XRP} CHF</p>
            <input value="4242 4242 4242 4242" readOnly aria-label="Carte de test" />
            <button disabled={busy || !(Number(chf) > 0)} onClick={pay}>{busy ? 'Traitement…' : `Payer ${chf} CHF`}</button>
          </>}
          <button className="ghost" onClick={() => dlg.current?.close()}>Fermer</button>
        </div>
      </dialog>
    </>
  );
}
