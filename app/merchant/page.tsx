import { db, terminalByKey, type Payment } from '@/lib/db';
import { EXPLORER } from '@/lib/xrpl';

export const dynamic = 'force-dynamic';

// Gated by the terminal key (?key=...), which maps to a merchant. Plain GET form: no JS needed.
export default async function Merchant({ searchParams }: { searchParams: Promise<{ key?: string }> }) {
  const { key } = await searchParams;
  const term = key ? terminalByKey(key) : undefined;
  if (!term) return <main><form className="box"><h1>Paiements reçus</h1><input name="key" placeholder="Clé du terminal" /><button>Voir</button></form></main>;
  const rows = db().prepare("SELECT * FROM payments WHERE merchant = ? AND status = 'paid' ORDER BY id DESC LIMIT 100").all(term.merchant) as Payment[];
  const total = rows.reduce((s, p) => s + p.drops, 0) / 1e6;
  return (
    <main>
      <div className="box"><h1>Paiements reçus</h1><p className="mut">{term.merchant}</p><p className="big">{total} XRP</p></div>
      {rows.map((p) => (
        <div key={p.id} className="box">
          <p>{p.drops / 1e6} XRP <span className="mut">· {new Date(p.created_at).toLocaleString('fr-CH')}</span></p>
          <a href={EXPLORER + p.hash} target="_blank"><code>{p.hash}</code></a>
        </div>
      ))}
      {!rows.length && <p className="mut">Aucun paiement.</p>}
    </main>
  );
}
