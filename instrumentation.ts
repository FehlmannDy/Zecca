// Runs once at server boot: refuse to start on a non-testnet URL.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') (await import('./lib/xrpl')).assertTestnet();
}
