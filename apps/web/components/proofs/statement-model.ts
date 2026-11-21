// Words for the statement page (/statement/[id]) and how it loads. On the mock ledger the hashes are simulated:
// no explorer links and no promise that the public ledger shows them (BUILD §8 rule 9).
import type { Statement } from '@zecca/contracts'
import { isApiError } from '../../lib/api'

export function ledgerCopy(s: Pick<Statement, 'attestation' | 'lines'>, simulated: boolean): { links: boolean; headline: string; amounts: string } {
  const count = s.lines.length
  const proven = s.lines.filter((l) => l.amountProof).length
  const amounts =
    s.attestation === 'proof'
      ? 'Amounts are hidden on the public ledger. Each amount here comes with a proof that the hidden amount in that transaction is exactly this one, so it can be checked without trusting Zecca.'
      : proven > 0
        ? `Amounts are hidden on the public ledger. ${proven} of ${count} come with a proof that can be checked without trusting Zecca; the others are attested by Zecca.`
        : `Amounts are hidden on the public ledger, so they are attested by Zecca: its signature below covers every line.${simulated ? '' : ' The links show that each payment happened.'}`
  return {
    links: !simulated,
    headline: simulated ? 'Test mode: these transactions are simulated, so they have no record on the public ledger.' : 'Anyone can check each line on the public ledger.',
    amounts,
  }
}

/** A statement that does not exist resolves to null; a network error or a server error stays an error (with a retry). */
export function missingAsNull<T>(p: Promise<T>): Promise<T | null> {
  return p.catch((e) => {
    if (isApiError(e) && e.status === 404) return null
    throw e
  })
}
