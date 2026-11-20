import { randomBytes } from 'node:crypto';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { db } from '@/lib/db';
import { rp, saveChallenge, startSession, takeChallenge } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// NB: auth bodies are WebAuthn blobs, not wallet material, so the seed guard (lib/guard.ts) is not applied here
// (base64url credential data could false-positive on the seed pattern).

/** POST {name} -> registration options. POST {flowId, response} -> verify, create the user, open a session. */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const { rpID, origin } = rp(req);
  if (!body) return Response.json({ error: 'invalid body' }, { status: 400 });

  if (!body.response) {
    const name = String(body.name ?? '').trim().slice(0, 40);
    if (!name) return Response.json({ error: 'name required' }, { status: 400 });
    const userId = randomBytes(16).toString('hex');
    const options = await generateRegistrationOptions({
      rpName: 'Zecca', rpID, userName: name, userID: new TextEncoder().encode(userId),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, // discoverable: login without typing a username
      extensions: { prf: {} }, // ask the authenticator to report PRF support (response.clientExtensionResults.prf.enabled)
    });
    return Response.json({ options, flowId: saveChallenge(options.challenge, userId, name) });
  }

  const flow = takeChallenge(String(body.flowId));
  if (!flow?.user_id) return Response.json({ error: 'challenge expired, retry' }, { status: 400 });
  const v = await verifyRegistrationResponse({ response: body.response, expectedChallenge: flow.challenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true }).catch(() => null);
  if (!v?.verified) return Response.json({ error: 'passkey not verified' }, { status: 400 });
  const c = v.registrationInfo.credential;
  db().prepare('INSERT INTO users(id, name, created_at) VALUES (?,?,?)').run(flow.user_id, flow.name, Date.now());
  db().prepare('INSERT INTO credentials(id, user_id, public_key, counter, transports) VALUES (?,?,?,?,?)').run(c.id, flow.user_id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports ?? []));
  await startSession(req, flow.user_id);
  return Response.json({ ok: true, credentialId: c.id, user: { id: flow.user_id, name: flow.name } });
}
