import { decode } from 'xrpl';
import { findSecret } from '@/lib/guard';
import { delegateWallet, submitBlob } from '@/lib/xrpl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Relay for client-signed blobs. Only accepts a DelegateSet toward OUR delegate: not an open relay. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || typeof body.tx_blob !== 'string' || !/^[0-9A-F]+$/i.test(body.tx_blob))
    return Response.json({ error: 'tx_blob (hex) required' }, { status: 400 });
  if (Object.keys(body).some((k) => k !== 'tx_blob') || findSecret(body))
    return Response.json({ error: 'unexpected field (secrets are never accepted)' }, { status: 400 });
  const tx = decode(body.tx_blob) as { TransactionType?: string; Authorize?: string };
  if (tx.TransactionType !== 'DelegateSet' || tx.Authorize !== delegateWallet().address)
    return Response.json({ error: 'only DelegateSet toward the platform delegate is relayed' }, { status: 400 });
  const { hash, engineResult } = await submitBlob(body.tx_blob);
  return Response.json({ hash, engineResult });
}
