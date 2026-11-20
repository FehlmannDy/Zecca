// Creates + funds the platform delegate and one merchant on the testnet faucet, writes .env.local.
import { Client } from 'xrpl';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

if (existsSync('.env.local')) { console.error('.env.local already exists, delete it first.'); process.exit(1); }
const client = new Client('wss://s.altnet.rippletest.net:51233');
await client.connect();
const [{ wallet: delegate }, { wallet: merchant }] = await Promise.all([client.fundWallet(), client.fundWallet()]);
await client.disconnect();
const env = readFileSync('.env.example', 'utf8')
  .replace('DELEGATE_SEED=', `DELEGATE_SEED=${delegate.seed}`)
  .replace('MERCHANT_ADDRESS=', `MERCHANT_ADDRESS=${merchant.address}`)
  .replace('TERMINAL_KEY=', `TERMINAL_KEY=${randomBytes(16).toString('hex')}`);
writeFileSync('.env.local', env);
console.log(`delegate ${delegate.address}\nmerchant ${merchant.address}\n.env.local written`);
