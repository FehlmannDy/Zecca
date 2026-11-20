'use client'
// Amount entry: a large field with the numeric keyboard (inputmode="decimal") and, for tills and phones, an
// on-screen keypad. The value is parsed with the contracts' parseUsdInput (integer cents, never floats).
import { useId } from 'react'
import { Delete } from 'lucide-react'
import { parseUsdInput } from '@zecca/contracts'
import { keypadPress, sanitizeAmountInput } from '@/lib/keypad'
import { cn } from '@/lib/cn'

export function AmountKeypad({
  value,
  onChange,
  label = 'Amount',
  pad = true,
  error,
  hint,
  className,
}: {
  value: string
  /** The typed text and its value in cents (null when empty or not a valid amount). */
  onChange: (value: string, minor: number | null) => void
  label?: string
  pad?: boolean
  error?: string
  hint?: string
  className?: string
}) {
  const id = useId()
  const set = (next: string) => onChange(next, next ? parseUsdInput(next) : null)
  const shown = value === '' ? '0' : value
  const size = shown.length > 8 ? 'text-[44px]' : shown.length > 5 ? 'text-[54px]' : 'text-[64px]'
  return (
    <div className={cn('flex w-full flex-col items-center', className)}>
      <label htmlFor={id} className="label-caps text-muted">
        {label}
      </label>
      <div className="relative mt-3 flex items-baseline justify-center">
        <span className={cn('tabular font-[720] tracking-[-0.045em] text-ink', size, 'leading-none')} aria-hidden="true">
          <span className="mr-0.5 text-[0.6em] align-[0.25em] font-[600] opacity-50">$</span>
          {shown}
        </span>
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          value={value}
          onChange={(e) => set(sanitizeAmountInput(e.target.value))}
          className="absolute inset-0 w-full cursor-text bg-transparent text-transparent caret-transparent outline-none focus-visible:rounded-[14px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--brass)]"
          aria-describedby={`${id}-msg`}
          aria-invalid={!!error}
        />
      </div>
      <p id={`${id}-msg`} className={cn('mt-3 min-h-5 text-[14px]', error ? 'text-alert' : 'text-muted')} aria-live="polite">
        {error ?? hint ?? ''}
      </p>
      {pad && (
        <div className="mt-4 grid w-full max-w-[320px] grid-cols-3 gap-2" role="group" aria-label="Keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'].map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => set(keypadPress(value, k))}
              className="grid h-14 place-items-center rounded-[14px] text-[24px] font-[600] text-ink transition-colors duration-150 hover:bg-ink/5 active:bg-ink/10"
              aria-label={k === 'back' ? 'Delete' : k === '.' ? 'Decimal point' : k}
            >
              {k === 'back' ? <Delete className="size-6" aria-hidden="true" /> : k}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
