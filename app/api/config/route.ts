import { delegateWallet, EXPLORER, WS_URL, assertTestnet } from '@/lib/xrpl';

export const dynamic = 'force-dynamic';

/** Public config for the browser (delegate ADDRESS only, never the seed). */
export function GET() {
  assertTestnet();
  return Response.json({ delegate: delegateWallet().address, wsUrl: WS_URL, explorer: EXPLORER, walletEnabled: process.env.GOOGLE_WALLET_ENABLED === 'true' });
}
