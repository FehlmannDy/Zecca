import { xrpToDrops } from 'xrpl';
import { db, cardByToken, terminalByKey, paymentByRequest, spentToday, type Payment } from '@/lib/db';
import { findSecret } from '@/lib/guard';
import { checkLimits } from '@/lib/limits';
import { availableDrops, signDelegatedPayment, submitBlob, waitValidated, EXPLORER } from '@/lib/xrpl';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const REASONS: Record<string, string> = {
  terNO_DELEGATE_PERMISSION: 'Carte révoquée',
  tecUNFUNDED_PAYMENT: 'Solde insuffisant',
  tecUNFUNDED: 'Solde insuffisant',
};
const reply = (status: number, b: object) => Response.json(b, { status });
const paid = (hash: string) => reply(200, { status: 'paid', hash, explorerUrl: EXPLORER + hash });
const refused = (reason: string) => reply(402, { status: 'refused', reason });

function finish(id: number, status: 'paid' | 'failed', hash: string | null, reason: string | null) {
  db().prepare('UPDATE payments SET status = ?, hash = ?, reason = ? WHERE id = ?').run(status, hash, reason, id);
}

export async function POST(req: Request) {
  const term = terminalByKey(req.headers.get('x-terminal-key') ?? '');
  if (!term) return reply(401, { error: 'bad terminal key' });
  const body = await req.json().catch(() => null);
  if (!body || findSecret(body)) return reply(400, { error: 'invalid body (secrets are never accepted)' });
  const { cardToken, amountXrp, requestId } = body;
  if (typeof cardToken !== 'string' || typeof requestId !== 'string' || !requestId || requestId.length > 100)
    return reply(400, { error: 'cardToken and requestId required' });
  let drops: string;
  try { drops = xrpToDrops(String(amountXrp)); if (BigInt(drops) <= 0n) throw 0; } catch { return reply(400, { error: 'invalid amountXrp' }); }

  const card = cardByToken(cardToken);
  if (!card) return reply(404, { status: 'refused', reason: 'Carte inconnue' });

  // Idempotence: request_id is UNIQUE; the first insert wins, replays get the stored outcome.
  const ins = db().prepare("INSERT OR IGNORE INTO payments(request_id, card_id, terminal_key, merchant, drops, status, created_at) VALUES (?,?,?,?,?,'pending',?)")
    .run(requestId, card.id, term.key, term.merchant, Number(drops), Date.now());
  if (!ins.changes) {
    const p = paymentByRequest(requestId) as Payment;
    if (p.status === 'paid') return paid(p.hash!);
    if (p.status === 'failed') return refused(p.reason ?? 'Refusé');
    return reply(409, { status: 'pending', reason: 'Paiement déjà en cours' });
  }
  const rowId = Number(ins.lastInsertRowid);
  const fail = (reason: string) => { finish(rowId, 'failed', null, reason); return refused(reason); };

  try {
    if (card.status === 'revoked') return fail('Carte révoquée');
    const limit = checkLimits(spentToday(card.id) - BigInt(drops), BigInt(drops)); // minus this row: it's already 'pending'
    if (limit) return fail(limit);
    if ((await availableDrops(card.address)) < BigInt(drops)) return fail('Solde insuffisant');

    const { blob, lastLedgerSequence } = await signDelegatedPayment(card.address, term.merchant, drops);
    const { hash, engineResult } = await submitBlob(blob);
    if (engineResult !== 'tesSUCCESS') {
      // Revoked on-chain outside the app: the ledger still refuses, so sync our DB.
      if (engineResult === 'terNO_DELEGATE_PERMISSION') db().prepare("UPDATE cards SET status = 'revoked' WHERE id = ?").run(card.id);
      return fail(REASONS[engineResult] ?? engineResult);
    }
    const final = await waitValidated(hash, lastLedgerSequence);
    if (final !== 'tesSUCCESS') return fail(REASONS[final] ?? final);
    finish(rowId, 'paid', hash, null);
    // TODO phase 4: GOOGLE_WALLET_LIVE_UPDATES balance patch
    return paid(hash);
  } catch (e) {
    return fail(`Erreur: ${(e as Error).message}`);
  }
}
