import { Client, Wallet, xrpToDrops, hashes, type SubmittableTransaction } from 'xrpl';

export const WS_URL = process.env.XRPL_URL ?? 'wss://s.altnet.rippletest.net:51233';
export const EXPLORER = 'https://testnet.xrpl.org/transactions/';

/** Testnet only: refuse anything that isn't a known test network. Called from instrumentation.ts at boot. */
export function assertTestnet() {
  if (!/altnet|testnet|devnet/i.test(WS_URL) || /mainnet|xrplcluster|s[12]\.ripple\.com/i.test(WS_URL))
    throw new Error(`Refusing to start: XRPL_URL (${WS_URL}) is not a testnet URL`);
}

const g = globalThis as unknown as { __xrpl?: Client; __xrplConn?: Promise<void> | null };

/** Singleton WebSocket client; reconnects lazily if the socket dropped (survives dev hot reload via globalThis). */
export async function getClient(): Promise<Client> {
  assertTestnet();
  const c = (g.__xrpl ??= new Client(WS_URL));
  if (!c.isConnected()) await (g.__xrplConn ??= c.connect().finally(() => { g.__xrplConn = null; }));
  return c;
}

export function delegateWallet(): Wallet {
  if (!process.env.DELEGATE_SEED) throw new Error('DELEGATE_SEED missing (run scripts/setup-testnet.mjs)');
  return Wallet.fromSeed(process.env.DELEGATE_SEED);
}

/** Submit a signed blob; return the preliminary engine_result right away (NOT submitAndWait: refusals never validate). */
export async function submitBlob(blob: string) {
  const c = await getClient();
  const r = await c.request({ command: 'submit', tx_blob: blob });
  return { hash: hashes.hashSignedTx(blob), engineResult: r.result.engine_result };
}

/** Poll `tx` by hash until validated, or until the ledger passes lastLedgerSequence. Returns the final TransactionResult. */
export async function waitValidated(hash: string, lastLedgerSequence: number): Promise<string> {
  const c = await getClient();
  for (;;) {
    try {
      const r = await c.request({ command: 'tx', transaction: hash });
      if (r.result.validated) return (r.result.meta as { TransactionResult: string }).TransactionResult;
    } catch { /* txnNotFound yet */ }
    if ((await c.getLedgerIndex()) > lastLedgerSequence) return 'expired';
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Spendable drops = balance - reserve (base + owner_count * increment), on the current (open) ledger. */
export async function availableDrops(address: string): Promise<bigint> {
  const c = await getClient();
  try {
    const [acc, srv] = await Promise.all([
      c.request({ command: 'account_info', account: address, ledger_index: 'current' }),
      c.request({ command: 'server_info' }),
    ]);
    const v = srv.result.info.validated_ledger!;
    const reserve = BigInt(xrpToDrops(v.reserve_base_xrp)) + BigInt(acc.result.account_data.OwnerCount) * BigInt(xrpToDrops(v.reserve_inc_xrp));
    const avail = BigInt(acc.result.account_data.Balance) - reserve;
    return avail > 0n ? avail : 0n;
  } catch (e) {
    if ((e as { data?: { error?: string } }).data?.error === 'actNotFound') return 0n;
    throw e;
  }
}

/** True if `account` currently delegates Payment to the platform delegate (Delegate ledger object, via account_objects). */
export async function hasDelegation(account: string): Promise<boolean> {
  const c = await getClient();
  const r = await c.request({ command: 'account_objects', account, ledger_index: 'current' });
  const delegate = delegateWallet().address;
  return r.result.account_objects.some((o) => {
    const x = o as unknown as { LedgerEntryType: string; Authorize?: string; Permissions?: unknown[] };
    return x.LedgerEntryType === 'Delegate' && x.Authorize === delegate && !!x.Permissions?.length && JSON.stringify(x.Permissions).includes('Payment');
  });
}

/** Delegated Payment signed by the platform delegate (it also pays the fee); funds leave `from`'s account. */
export async function signDelegatedPayment(from: string, to: string, drops: string) {
  const c = await getClient();
  const w = delegateWallet();
  const tx = await c.autofill({ TransactionType: 'Payment', Account: from, Delegate: w.address, Destination: to, Amount: drops } as SubmittableTransaction);
  return { blob: w.sign(tx).tx_blob, lastLedgerSequence: tx.LastLedgerSequence as number };
}
