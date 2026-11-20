import { randomBytes } from 'node:crypto';
import { isValidClassicAddress } from 'xrpl';
import { db, cardByToken, type Card } from '@/lib/db';
import { findSecret } from '@/lib/guard';
import { hasDelegation } from '@/lib/xrpl';
import { currentUser } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** POST {address}: after the client's DelegateSet, verify on-chain, then issue an opaque card token. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || findSecret(body)) return bad('invalid body (secrets are never accepted)');
  const user = await currentUser();
  if (!user) return bad('login required', 401);
  if (!isValidClassicAddress(body.address)) return bad('valid XRPL address required');
  if (!(await hasDelegation(body.address))) return bad('no Payment delegation to the platform on-chain yet', 409);
  const existing = db().prepare("SELECT * FROM cards WHERE address = ? AND status = 'active'").get(body.address) as Card | undefined;
  if (existing) return existing.user_id === user.id ? Response.json({ token: existing.token, status: 'active' }) : bad('address already bound to another user', 409);
  // opaque, unguessable; never a seed or the address. 'zc_' prefix: a bare base64url token starting with 's' could false-positive the seed guard.
  const token = 'zc_' + randomBytes(24).toString('base64url');
  db().prepare('INSERT INTO cards(token, address, user_id, created_at) VALUES (?, ?, ?, ?)').run(token, body.address, user.id, Date.now());
  return Response.json({ token, status: 'active' }, { status: 201 });
}

/** GET ?token=: card state (token holder only). */
export async function GET(req: Request) {
  const card = cardByToken(new URL(req.url).searchParams.get('token') ?? '');
  return card ? Response.json({ status: card.status, address: card.address }) : bad('unknown card', 404);
}

/** PATCH {token}: mark revoked, but only once the chain confirms the delegation is gone (server never trusts the client). */
export async function PATCH(req: Request) {
  const body = await req.json().catch(() => null);
  if (!body || findSecret(body)) return bad('invalid body');
  const card = cardByToken(String(body.token));
  if (!card) return bad('unknown card', 404);
  const user = await currentUser();
  if (card.user_id && card.user_id !== user?.id) return bad('not your card', 403);
  if (await hasDelegation(card.address)) return bad('delegation still active on-chain', 409);
  db().prepare("UPDATE cards SET status = 'revoked' WHERE id = ?").run(card.id);
  return Response.json({ status: 'revoked' });
}
