// Rejects any request body that looks like it carries an XRPL seed/secret (rule: client seed never reaches the server).
// Family seed = 's' + base58 (XRPL alphabet), 20-34 chars total (e.g. "sEd..." 29 chars, "sn..." 29 chars).
const SEED = /^s[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{18,33}$/;
const KEY = /seed|secret|private/i;

export function findSecret(v: unknown, path = ''): string | null {
  if (typeof v === 'string') return SEED.test(v) ? path || '(root)' : null;
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (KEY.test(k)) return `${path}.${k}`;
      const r = findSecret(x, `${path}.${k}`);
      if (r) return r;
    }
  }
  return null;
}
