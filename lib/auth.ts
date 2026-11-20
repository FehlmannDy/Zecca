// Passkey (WebAuthn) accounts + cookie sessions, stored in our SQLite. No third party.
// Lib: @simplewebauthn/server (https://simplewebauthn.dev). rpID/origin come from env, else from the request.
import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { db } from './db';

const COOKIE = 'zecca_session';
const SESSION_MS = 7 * 24 * 3600 * 1000;
const CHALLENGE_MS = 5 * 60 * 1000;

export function rp(req: Request) {
  const u = new URL(req.url);
  return { rpID: process.env.WEBAUTHN_RP_ID ?? u.hostname, origin: process.env.WEBAUTHN_ORIGIN ?? req.headers.get('origin') ?? u.origin };
}

export function saveChallenge(challenge: string, userId?: string, name?: string) {
  const flowId = randomBytes(16).toString('base64url');
  db().prepare('DELETE FROM challenges WHERE expires < ?').run(Date.now());
  db().prepare('INSERT INTO challenges(flow_id, challenge, user_id, name, expires) VALUES (?,?,?,?,?)').run(flowId, challenge, userId ?? null, name ?? null, Date.now() + CHALLENGE_MS);
  return flowId;
}

/** One-shot: the challenge is deleted as it is read (no replay). */
export function takeChallenge(flowId: string) {
  const row = db().prepare('SELECT * FROM challenges WHERE flow_id = ? AND expires > ?').get(flowId, Date.now()) as { challenge: string; user_id: string | null; name: string | null } | undefined;
  db().prepare('DELETE FROM challenges WHERE flow_id = ?').run(flowId);
  return row;
}

export async function startSession(req: Request, userId: string) {
  const token = randomBytes(32).toString('base64url');
  db().prepare('INSERT INTO sessions(token, user_id, expires) VALUES (?,?,?)').run(token, userId, Date.now() + SESSION_MS);
  (await cookies()).set(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: rp(req).origin.startsWith('https:'), path: '/', maxAge: SESSION_MS / 1000 });
}

export async function endSession() {
  const jar = await cookies();
  const t = jar.get(COOKIE)?.value;
  if (t) db().prepare('DELETE FROM sessions WHERE token = ?').run(t);
  jar.delete(COOKIE);
}

export async function currentUser(): Promise<{ id: string; name: string } | null> {
  const t = (await cookies()).get(COOKIE)?.value;
  if (!t) return null;
  return (db().prepare('SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?').get(t, Date.now()) as { id: string; name: string } | undefined) ?? null;
}
