import { xrpToDrops } from 'xrpl';
// Configurable caps (XRP). Defaults suit the testnet demo.
export const MAX_TX_DROPS = BigInt(xrpToDrops(process.env.MAX_TX_XRP ?? '20'));
export const MAX_DAILY_DROPS = BigInt(xrpToDrops(process.env.MAX_DAILY_XRP ?? '50'));

/** Returns a human reason if the charge breaks a cap, else null. */
export function checkLimits(spentTodayDrops: bigint, drops: bigint): string | null {
  if (drops > MAX_TX_DROPS) return `Plafond par transaction dépassé (max ${Number(MAX_TX_DROPS) / 1e6} XRP)`;
  if (spentTodayDrops + drops > MAX_DAILY_DROPS) return `Plafond journalier dépassé (max ${Number(MAX_DAILY_DROPS) / 1e6} XRP)`;
  return null;
}
