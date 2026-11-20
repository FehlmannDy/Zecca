// Browser-side helpers: XRPL client (direct to the testnet), local card storage, config from our server.
import { Client, Wallet, type SubmittableTransaction } from 'xrpl';
import { decryptSeed, type Vault } from './seedvault';
import { prfKey, savedCredentialId } from './passkey';

export type Config = { delegate: string; wsUrl: string; explorer: string; walletEnabled: boolean };
export type Stored = { address: string; vault: Vault; token?: string; user?: string };

const KEY = 'zecca.card';
export const loadCard = (): Stored | null => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
export const saveCard = (c: Stored) => localStorage.setItem(KEY, JSON.stringify(c));

let cfg: Promise<Config> | undefined;
export const getConfig = () => (cfg ??= fetch('/api/config').then((r) => r.json()));

let cli: Promise<Client> | undefined;
export const getClient = () => (cli ??= getConfig().then(async (c) => { const x = new Client(c.wsUrl); await x.connect(); return x; }));

/** Passkey-protected vault: biometric prompt, no PIN. PIN vault: pass the PIN. */
export async function unlock(pin?: string): Promise<Wallet> {
  const c = loadCard();
  if (!c) throw new Error('no card');
  if (c.vault.kind === 'prf') {
    const key = await prfKey(savedCredentialId());
    if (!key) throw new Error('Passkey indisponible sur cet appareil');
    return Wallet.fromSeed(await decryptSeed(c.vault, key));
  }
  if (!pin) throw new Error('PIN requis');
  return Wallet.fromSeed(await decryptSeed(c.vault, pin));
}

/** Sign (in the browser) and submit a DelegateSet toward the platform delegate; Permissions [] revokes. */
export async function delegateSet(wallet: Wallet, grant: boolean) {
  const [client, { delegate }] = await Promise.all([getClient(), getConfig()]);
  const tx = await client.autofill({
    TransactionType: 'DelegateSet', Account: wallet.address, Authorize: delegate,
    Permissions: grant ? [{ Permission: { PermissionValue: 'Payment' } }] : [],
  } as SubmittableTransaction);
  const r = await client.submitAndWait(wallet.sign(tx).tx_blob);
  const res = (r.result.meta as { TransactionResult: string }).TransactionResult;
  if (res !== 'tesSUCCESS') throw new Error(res);
  return r.result.hash;
}
