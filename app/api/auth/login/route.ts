import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { db } from '@/lib/db';
import { rp, saveChallenge, startSession, takeChallenge } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Cred = { id: string; user_id: string; public_key: Buffer; counter: number; transports: string };

/** POST {} -> options (discoverable credentials, no username). POST {flowId, response} -> verify + session. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const { rpID, origin } = rp(req);
  if (!body) return Response.json({ error: 'invalid body' }, { status: 400 });

  if (!body.response) {
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    return Response.json({ options, flowId: saveChallenge(options.challenge) });
  }

  const flow = takeChallenge(String(body.flowId));
  const cred = db().prepare('SELECT * FROM credentials WHERE id = ?').get(String(body.response.id)) as Cred | undefined;
  if (!flow || !cred) return Response.json({ error: 'unknown passkey or expired challenge' }, { status: 400 });
  const v = await verifyAuthenticationResponse({
    response: body.response, expectedChallenge: flow.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: JSON.parse(cred.transports) },
  }).catch(() => null);
  if (!v?.verified) return Response.json({ error: 'passkey not verified' }, { status: 401 });
  db().prepare('UPDATE credentials SET counter = ? WHERE id = ?').run(v.authenticationInfo.newCounter, cred.id);
  await startSession(req, cred.user_id);
  const user = db().prepare('SELECT id, name FROM users WHERE id = ?').get(cred.user_id);
  return Response.json({ ok: true, credentialId: cred.id, user });
}
