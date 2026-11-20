// Browser passkey helpers. Login/registration ceremonies go through our server (SimpleWebAuthn);
// the vault key comes from the WebAuthn PRF extension, evaluated locally and NEVER sent anywhere.
// PRF ref: https://developer.mozilla.org/docs/Web/API/Web_Authentication_API/WebAuthn_extensions#prf
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

const CRED_KEY = 'zecca.passkey';
const SALT = new TextEncoder().encode('zecca-vault-v1');
const PRF_KEY = 'zecca.prf';
/** true/false once registration told us whether this passkey supports PRF; null = unknown (e.g. logged in on a new device). */
export const prfSupport = (): boolean | null => { try { const v = localStorage.getItem(PRF_KEY); return v === null ? null : v === '1'; } catch { return null; } };
export const savedCredentialId = () => { try { return localStorage.getItem(CRED_KEY); } catch { return null; } };

async function post(path: string, body: object) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? 'request failed');
  return j;
}

export type User = { id: string; name: string };

export async function registerPasskey(name: string): Promise<User> {
  const { options, flowId } = await post('/api/auth/register', { name });
  const response = await startRegistration({ optionsJSON: options });
  const r = await post('/api/auth/register', { flowId, response });
  localStorage.setItem(CRED_KEY, r.credentialId);
  // Bitwarden & co. may not implement PRF: remember it so onboarding goes straight to the PIN, with no extra prompt.
  localStorage.setItem(PRF_KEY, (response.clientExtensionResults as { prf?: { enabled?: boolean } }).prf?.enabled ? '1' : '0');
  return r.user;
}

export async function loginWithPasskey(): Promise<User> {
  const { options, flowId } = await post('/api/auth/login', {});
  const response = await startAuthentication({ optionsJSON: options });
  const r = await post('/api/auth/login', { flowId, response });
  localStorage.setItem(CRED_KEY, r.credentialId);
  return r.user;
}

export async function getMe(): Promise<User | null> {
  const r = await fetch('/api/auth/session');
  return r.ok ? (await r.json()).user : null;
}
export const logout = () => fetch('/api/auth/session', { method: 'DELETE' });

/** Derive the vault key from the passkey via PRF. Returns null if this browser/authenticator has no PRF. */
export async function prfKey(credentialId: string | null): Promise<CryptoKey | null> {
  if (!credentialId) return null;
  const id = Uint8Array.from(atob(credentialId.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  try {
    const cred = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), // local-only ceremony: nothing is verified server-side
        allowCredentials: [{ id, type: 'public-key' }], userVerification: 'required',
        extensions: { prf: { eval: { first: SALT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    const out = (cred?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)?.prf?.results?.first;
    return out ? crypto.subtle.importKey('raw', out, 'AES-GCM', false, ['encrypt', 'decrypt']) : null;
  } catch { return null; }
}
