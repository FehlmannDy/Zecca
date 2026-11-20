'use client'
// The approve step every payment goes through (UI.md §5.4): what, to whom, the fee, "Approve"; then the arches
// with "Sealing the amount" -> "Sending" -> "Confirmed"; then success or one sentence of failure and "Try again".
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { formatUsd } from '@zecca/contracts'
import { approveStatus, archesFill } from '@/lib/arches'
import { isApiError, type ZeccaApiError } from '@/lib/api'
import { ArchesProgress } from './arches'
import { Button } from './bits'
import { Sheet } from './sheet'

export type ApproveOutcome = {
  /** "Sent. $12.00 to Carla." */
  title: string
  line?: ReactNode
  /** Read by screen readers: "Sent, 12 dollars to Carla". */
  announce: string
}

type Phase = 'review' | 'working' | 'confirmed' | 'success' | 'failure'

export function ApproveSheet({
  open,
  onClose,
  title,
  subline,
  feeMinor,
  details,
  approveLabel = 'Approve',
  expectedMs = 10_000,
  run,
  onDone,
  onViewDetails,
  onError,
}: {
  open: boolean
  onClose: () => void
  title: string
  subline?: ReactNode
  /** Shown as "Fee $0.00". Leave out when there is no fee line. */
  feeMinor?: number
  details?: ReactNode
  approveLabel?: string
  expectedMs?: number
  /** Prepare, sign and submit. Resolve with what to show; throw a ZeccaApiError (its message is shown as is). */
  run: () => Promise<ApproveOutcome>
  onDone?: () => void
  onViewDetails?: () => void
  /** Return true to take the error over (e.g. open the limits sheet instead). */
  onError?: (e: ZeccaApiError) => boolean
}) {
  const [phase, setPhase] = useState<Phase>('review')
  const [status, setStatus] = useState('')
  const [outcome, setOutcome] = useState<ApproveOutcome | null>(null)
  const [error, setError] = useState('')
  const started = useRef(0)

  useEffect(() => {
    if (open) {
      setPhase('review')
      setOutcome(null)
      setError('')
      setStatus('')
    }
  }, [open])

  // The status line follows the same clock as the arches.
  useEffect(() => {
    if (phase !== 'working') return
    const id = setInterval(() => setStatus(approveStatus(archesFill(performance.now() - started.current, expectedMs), false)), 250)
    return () => clearInterval(id)
  }, [phase, expectedMs])

  async function approve() {
    started.current = performance.now()
    setPhase('working')
    setStatus(approveStatus(0, false))
    setError('')
    try {
      const out = await run()
      setOutcome(out)
      setStatus('Confirmed')
      setPhase('confirmed')
      setTimeout(() => setPhase('success'), 700)
    } catch (e) {
      if (isApiError(e) && onError?.(e)) {
        onClose()
        return
      }
      setError(e instanceof Error && e.message ? e.message : 'That didn’t go through and nothing was taken. Try again.')
      setStatus('')
      setPhase('failure')
    }
  }

  const busy = phase === 'working' || phase === 'confirmed'
  const archState = phase === 'review' ? 'idle' : phase === 'failure' ? 'failed' : phase === 'working' ? 'running' : 'done'

  return (
    <Sheet open={open} onClose={onClose} title={phase === 'success' && outcome ? outcome.title : title} hideTitle dismissible={!busy}>
      <div className="flex flex-col items-center text-center">
        {phase === 'review' && (
          <>
            <p className="mt-2 text-[22px] font-[740] leading-tight tracking-[-0.025em]">{title}</p>
            {subline && <p className="mt-1.5 text-[15px] text-muted">{subline}</p>}
            {details && <div className="mt-4 w-full text-left">{details}</div>}
            {feeMinor !== undefined && (
              <div className="mt-5 flex w-full items-center justify-between border-t border-line pt-4 text-[15px]">
                <span className="text-muted">Fee</span>
                <span className="tabular font-[650]">{formatUsd(feeMinor)}</span>
              </div>
            )}
            <Button className="mt-6 w-full" onClick={approve} data-autofocus>
              {approveLabel}
            </Button>
          </>
        )}

        {phase !== 'review' && (
          <>
            <p className="mt-2 text-[17px] font-[680] tracking-[-0.01em]">{phase === 'success' && outcome ? outcome.title : title}</p>
            <ArchesProgress state={archState} expectedMs={expectedMs} className="mt-7 h-11" label={status || 'Payment progress'} />
            <p className="mt-4 min-h-6 text-[15px] text-muted" aria-hidden="true">
              {phase === 'failure' ? '' : phase === 'success' ? '' : status}
            </p>
          </>
        )}

        {phase === 'success' && outcome && (
          <>
            {outcome.line && <div className="mt-1 text-[15px] text-muted">{outcome.line}</div>}
            <div className="mt-6 flex w-full flex-col gap-2">
              <Button
                className="w-full"
                data-autofocus
                onClick={() => {
                  onDone?.()
                  onClose()
                }}
              >
                Done
              </Button>
              {onViewDetails && (
                <Button variant="ghost" className="w-full" onClick={onViewDetails}>
                  View details
                </Button>
              )}
            </div>
          </>
        )}

        {phase === 'failure' && (
          <>
            <p className="mt-1 max-w-[34ch] text-[15px] text-alert" role="alert">
              {error}
            </p>
            <div className="mt-6 flex w-full flex-col gap-2">
              <Button className="w-full" onClick={approve}>
                Try again
              </Button>
              <Button variant="ghost" className="w-full" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {/* One polite live region for the whole flow. */}
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {phase === 'working' ? status : phase === 'success' && outcome ? outcome.announce : phase === 'confirmed' ? 'Confirmed' : ''}
        </p>
      </div>
    </Sheet>
  )
}
