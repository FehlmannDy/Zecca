// base64url <-> bytes, the encoding WebAuthn JSON and Privy's passkey endpoints use.

const ALPHABET = /^[A-Za-z0-9_-]*={0,2}$/

export function base64UrlToBytes(value: string): Uint8Array {
  if (!ALPHABET.test(value)) throw new Error('Invalid base64url value')
  const normalized = value.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i)
  return bytes
}

/** An ArrayBuffer copy of the decoded bytes (what the WebAuthn browser API takes). */
export function base64UrlToBuffer(value: string): ArrayBuffer {
  const bytes = base64UrlToBytes(value)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function bytesToBase64Url(value: ArrayBuffer | ArrayBufferView): string {
  const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
