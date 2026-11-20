'use client';
import { useEffect, useRef, useState } from 'react';

type Result = { status: string; hash?: string; explorerUrl?: string; reason?: string; error?: string };
type Phase = 'amount' | 'scan' | 'busy' | 'done';

// QR scan: native BarcodeDetector (Chrome), fallback to local jsQR. Camera needs https or localhost.
export default function Terminal() {
  const [key, setKey] = useState('');
  const [amount, setAmount] = useState('5');
  const [phase, setPhase] = useState<Phase>('amount');
  const [res, setRes] = useState<Result>();
  const video = useRef<HTMLVideoElement>(null);
  const stop = useRef(() => {});

  useEffect(() => { try { setKey(localStorage.getItem('zecca.terminalKey') ?? ''); } catch {} return () => stop.current(); }, []);

  async function charge(cardToken: string, requestId: string) {
    setPhase('busy');
    try {
      const r = await fetch('/api/charge', { method: 'POST', headers: { 'content-type': 'application/json', 'x-terminal-key': key },
        body: JSON.stringify({ cardToken, amountXrp: amount, requestId }) });
      setRes(await r.json());
    } catch { setRes({ status: 'refused', reason: 'Réseau indisponible' }); }
    setPhase('done');
  }

  async function start() {
    localStorage.setItem('zecca.terminalKey', key);
    setRes(undefined); setPhase('scan');
    const requestId = crypto.randomUUID(); // one id per attempt: a re-read of the same QR can never pay twice
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    let live = true;
    stop.current = () => { live = false; stream.getTracks().forEach((t) => t.stop()); };
    const v = video.current!; v.srcObject = stream; await v.play();
    const native = 'BarcodeDetector' in window ? new (window as any).BarcodeDetector({ formats: ['qr_code'] }) : null;
    const jsQR = native ? null : (await import('jsqr')).default;
    const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    while (live) {
      let value: string | undefined;
      if (native) value = (await native.detect(v))[0]?.rawValue;
      else if (v.videoWidth) {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight; ctx.drawImage(v, 0, 0);
        value = jsQR!(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data;
      }
      if (value) { stop.current(); return charge(value, requestId); }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const paid = res?.status === 'paid';
  return (
    <main style={phase === 'done' ? { minHeight: '100vh', alignContent: 'center', background: paid ? '#14532d' : '#7f1d1d', maxWidth: 'none' } : undefined}>
      {phase === 'amount' && <div className="box">
        <h1>Terminal</h1>
        <input placeholder="Clé du terminal" value={key} onChange={(e) => setKey(e.target.value)} />
        <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <p className="mut">Montant en XRP</p>
        <button disabled={!key || !(Number(amount) > 0)} onClick={start}>Encaisser {amount} XRP</button>
      </div>}
      {phase === 'scan' && <div className="box"><h2>Présentez votre carte</h2><p className="big">{amount} XRP</p>
        <video ref={video} playsInline muted style={{ width: '100%', borderRadius: 12 }} />
        <button className="ghost" onClick={() => { stop.current(); setPhase('amount'); }}>Annuler</button></div>}
      {phase === 'busy' && <div className="box"><h2>Paiement en cours…</h2></div>}
      {phase === 'done' && <div className="box" style={{ textAlign: 'center' }}>
        <p className="big">{paid ? 'Payé ✓' : 'Refusé'}</p>
        {paid ? <a href={res!.explorerUrl} target="_blank"><code>{res!.hash}</code></a> : <p>{res?.reason ?? res?.error}</p>}
        <button onClick={() => setPhase('amount')}>Nouveau paiement</button></div>}
    </main>
  );
}
