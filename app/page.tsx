import Link from 'next/link';

export default function Home() {
  return (
    <main className="wide">
      <section className="hero">
        <div style={{ display: 'grid', gap: 14 }}>
          <h1>Une carte de paiement dont vous gardez les clés.</h1>
          <p className="lead">Zecca débite votre compte XRPL uniquement quand vous présentez la carte au terminal. Vous pouvez la révoquer en un clic.</p>
          <p className="notice">Démo sur le testnet XRPL : l&apos;argent est fictif.</p>
          <div className="actions">
            <Link href="/onboard" className="btn">Créer ma carte</Link>
            <Link href="/terminal" className="btn ghost">Ouvrir le terminal</Link>
          </div>
        </div>
        <div className="paycard" aria-hidden="true">
          <span className="brand">ZECCA</span>
          <span className="amount">100 XRP</span>
          <span className="tag">Carte déléguée · testnet</span>
        </div>
      </section>

      <section className="paths">
        <div className="box"><h2>Je veux payer</h2>
          <p className="mut">Créez une carte dans votre navigateur, puis présentez son QR code.</p>
          <div className="row"><Link href="/onboard" className="btn">Créer ma carte</Link><Link href="/card" className="btn ghost">Voir ma carte</Link></div></div>
        <div className="box"><h2>Je veux encaisser</h2>
          <p className="mut">Saisissez un montant, scannez la carte du client, suivez les paiements reçus.</p>
          <div className="row"><Link href="/terminal" className="btn">Ouvrir le terminal</Link><Link href="/merchant" className="btn ghost">Paiements reçus</Link></div></div>
      </section>

      <section style={{ display: 'grid', gap: 16 }}>
        <h2>Comment ça marche</h2>
        <ol className="steps">
          <li><h3>Créez la carte</h3><p className="mut">Le compte XRPL est créé dans votre navigateur. Votre clé reste chez vous, chiffrée par un PIN.</p></li>
          <li><h3>Payez avec le QR code</h3><p className="mut">Le terminal le scanne. Le paiement part de votre compte, jamais au-delà de votre solde.</p></li>
          <li><h3>Révoquez quand vous voulez</h3><p className="mut">Un clic, et le paiement suivant est refusé immédiatement.</p></li>
        </ol>
      </section>
      <p className="mut">Aucun service tiers : seul le testnet XRPL est contacté.</p>
    </main>
  );
}
