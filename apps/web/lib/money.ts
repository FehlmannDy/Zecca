// Display helpers over the contracts' integer money functions. Format only at the last moment.
import { splitUsd, spokenUsd } from '@zecca/contracts'

export type AmountParts = { sign: '' | '+' | '-'; dollars: string; cents: string; text: string; spoken: string }

/** Received money carries "+" (never colour alone); sent money is plain. */
export function amountParts(minor: number, opts: { direction?: 'in' | 'out' } = {}): AmountParts {
  if (!Number.isSafeInteger(minor)) throw new TypeError(`amount must be an integer number of cents, got ${minor}`)
  const { dollars, cents } = splitUsd(minor)
  const sign = minor < 0 ? '-' : opts.direction === 'in' ? '+' : ''
  return { sign, dollars, cents, text: `${sign}$${dollars}.${cents}`, spoken: spokenUsd(Math.abs(minor)) }
}
