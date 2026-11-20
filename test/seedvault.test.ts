import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSeed, decryptSeed } from '../lib/seedvault.ts';

test('seed round-trips with the right PIN, fails with a wrong one, and is not stored in clear', async () => {
  const v = await encryptSeed('sEdTM1uX8pu2do5XvTnutH6HsouMaM2', '1234');
  assert.equal(await decryptSeed(v, '1234'), 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2');
  await assert.rejects(decryptSeed(v, '0000'));
  assert.ok(!JSON.stringify(v).includes('sEdTM1'));
});

test('works with a CryptoKey (passkey PRF path) and tags the vault', async () => {
  const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const v = await encryptSeed('sEdTM1uX8pu2do5XvTnutH6HsouMaM2', k);
  assert.equal(v.kind, 'prf');
  assert.equal(await decryptSeed(v, k), 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2');
  await assert.rejects(decryptSeed(v, await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['decrypt'])));
});
