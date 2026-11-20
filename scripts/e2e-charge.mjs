// E2E on the testnet against a RUNNING server: node --env-file=.env.local scripts/e2e-charge.mjs
// Needs `next start` (or dev) running with the same .env.local. Uses BASE_URL (default http://localhost:3000).
import { Client, Wallet } from 'xrpl';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const delegate = Wallet.fromSeed(process.env.DELEGATE_SEED).address;
const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();

// Passkey ceremonies can't run in Node: seed a test user + session straight in the app's SQLite file (same DB_PATH as the server).
await fetch(BASE + '/api/cards?token=warmup'); // first DB touch creates the schema
const sdb = new Database(process.env.DB_PATH ?? 'data/zecca.db');
const uid = 'e2e-' + randomBytes(4).toString('hex'), sess = randomBytes(24).toString('base64url');
sdb.prepare('INSERT INTO users(id, name, created_at) VALUES (?,?,?)').run(uid, 'e2e', Date.now());
sdb.prepare('INSERT INTO sessions(token, user_id, expires) VALUES (?,?,?)').run(sess, uid, Date.now() + 3600e3);
const COOKIE = { cookie: 'zecca_session=' + sess };

const post = (path, body, headers = {}, method = 'POST') =>
  fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    .then(async (r) => ({ http: r.status, ...(await r.json()) }));
const charge = (cardToken, amountXrp, requestId = crypto.randomUUID()) =>
  post('/api/charge', { cardToken, amountXrp, requestId }, { 'x-terminal-key': process.env.TERMINAL_KEY });
const delegateSet = (wallet, permissions) =>
  client.submitAndWait({ TransactionType: 'DelegateSet', Account: wallet.address, Authorize: delegate, Permissions: permissions }, { wallet, autofill: true });
const newCard = async () => {
  const { wallet } = await client.fundWallet();
  await delegateSet(wallet, [{ Permission: { PermissionValue: 'Payment' } }]);
  const c = await post('/api/cards', { address: wallet.address }, COOKIE);
  assert.ok(c.token?.startsWith('zc_'), 'card created: ' + JSON.stringify(c));
  return { wallet, token: c.token };
};
const ok = (m) => console.log('OK  ' + m);

// 0. server must reject anything that looks like a seed
const s = await post('/api/cards', { address: 'rwJieedJemxd7GKHya6yRcDfnDKpBZHwks', seed: 'sEdTM1uX8pu2do5XvTnutH6HsouMaM2' });
assert.equal(s.http, 400); ok('seed-like field rejected (400)');
assert.equal((await post('/api/cards', { address: 'rwJieedJemxd7GKHya6yRcDfnDKpBZHwks' })).http, 401); ok('card creation without login rejected (401)');

// 1. paid
const a = await newCard();
const r1 = await charge(a.token, 5);
assert.equal(r1.status, 'paid', JSON.stringify(r1)); ok(`paid 5 XRP ${r1.explorerUrl}`);

// 1b. idempotence: same requestId replayed returns same hash, no second payment
const id = crypto.randomUUID();
const i1 = await charge(a.token, 1, id), i2 = await charge(a.token, 1, id);
assert.equal(i1.hash, i2.hash); ok('idempotent requestId');

// 2. per-transaction cap
const r2 = await charge(a.token, Number(process.env.MAX_TX_XRP ?? 20) + 1);
assert.equal(r2.status, 'refused'); assert.match(r2.reason, /Plafond par transaction/); ok('over per-tx cap refused: ' + r2.reason);

// 3. insufficient balance: drain the card account to ~8 XRP, then ask 15
const b = await newCard();
await client.submitAndWait({ TransactionType: 'Payment', Account: b.wallet.address, Destination: delegate, Amount: '88000000' }, { wallet: b.wallet, autofill: true });
const r3 = await charge(b.token, 15);
assert.equal(r3.status, 'refused'); assert.equal(r3.reason, 'Solde insuffisant'); ok('insufficient balance refused');

// 4a. revoke on-chain only (server not told): ledger itself must refuse, fast
await delegateSet(a.wallet, []);
let t = Date.now();
const r4 = await charge(a.token, 5);
const dt = Date.now() - t;
assert.equal(r4.reason, 'Carte révoquée'); assert.ok(dt < 2000, `refusal took ${dt}ms`); ok(`on-chain revoke -> refused in ${dt}ms`);

// 4b. revoke through the app flow (PATCH verifies on-chain), then charge
const c = await newCard();
assert.equal((await post('/api/cards', { token: c.token }, COOKIE, 'PATCH')).http, 409); ok('PATCH refused while delegation still active');
await delegateSet(c.wallet, []);
assert.equal((await post('/api/cards', { token: c.token }, COOKIE, 'PATCH')).status, 'revoked');
t = Date.now();
const r5 = await charge(c.token, 5);
assert.equal(r5.reason, 'Carte révoquée'); ok(`app revoke -> refused in ${Date.now() - t}ms`);

sdb.prepare('DELETE FROM sessions WHERE user_id = ?').run(uid);
await client.disconnect();
console.log('ALL E2E PASSED');
