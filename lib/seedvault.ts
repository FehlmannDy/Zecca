// Seed encryption in the browser (WebCrypto, AES-GCM). The seed never leaves the browser.
// Key comes from either a PIN (PBKDF2) or a passkey (WebAuthn PRF output, see lib/passkey.ts).
// Ref: https://developer.mozilla.org/docs/Web/API/SubtleCrypto/deriveKey
const enc = new TextEncoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export type Vault = { kind?: 'prf'; salt: string; iv: string; ct: string };
export type Secret = string | CryptoKey; // PIN or passkey-derived key

async function pinKey(pin: string, salt: Uint8Array) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations: 200_000, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptSeed(seed: string, secret: Secret): Promise<Vault> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const salt = typeof secret === 'string' ? crypto.getRandomValues(new Uint8Array(16)) : new Uint8Array(0);
  const key = typeof secret === 'string' ? await pinKey(secret, salt) : secret;
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(seed)));
  return { ...(typeof secret === 'string' ? {} : { kind: 'prf' as const }), salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** Throws on wrong PIN / wrong passkey (AES-GCM auth failure). */
export async function decryptSeed(v: Vault, secret: Secret): Promise<string> {
  const key = typeof secret === 'string' ? await pinKey(secret, unb64(v.salt)) : secret;
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(v.iv) as BufferSource }, key, unb64(v.ct) as BufferSource);
  return new TextDecoder().decode(pt);
}
