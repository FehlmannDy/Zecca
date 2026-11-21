// The hero's headline, naming only what is switched on in GET /v1/config: the card spends, Earn earns, the market
// owns gold. Its own module so the client headline does not pull the page copy and the demo data into the bundle.
export function heroTitle(on: { card: boolean; earn: boolean; market: boolean }): string {
  const verbs = ['Pay', on.card && 'spend', on.earn && 'earn', on.market && 'own gold'].filter((v): v is string => !!v)
  const list = verbs.length > 1 ? `${verbs.slice(0, -1).join(', ')} and ${verbs[verbs.length - 1]}` : verbs[0]
  return `${list}. One app, on the XRP Ledger.`
}
