import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSecret } from '../lib/guard.ts';

test('rejects seeds and secret-ish keys, accepts normal bodies', () => {
  assert.ok(findSecret({ a: { b: 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2' } }));
  assert.ok(findSecret({ seed: 'x' }));
  assert.ok(findSecret({ x: 'snoPBrXtMeMyMHUVTgbuqAfg1SUTb' }));
  assert.equal(findSecret({ cardToken: 'abc_DEF-123', amountXrp: 5, address: 'rwJieedJemxd7GKHya6yRcDfnDKpBZHwks' }), null);
});
