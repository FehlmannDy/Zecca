'use client'
// "Withdraw": everything in Earn comes back as dollars after the vault's waiting period (4 to 8 hours).
import { formatUsd } from '@zecca/contracts'
import { useApp } from '@/lib/app'
import { ApproveSheet } from '@/components/zecca/approve-sheet'
import { feeLine, timeText, xrpText, type EarnPositionView } from './earn-model'

export function WithdrawSheet({ open, onClose, position, onRequested }: { open: boolean; onClose: () => void; position: EarnPositionView; onRequested: () => void }) {
  const { api, config } = useApp()
  return (
    <ApproveSheet
      open={open}
      onClose={onClose}
      title={`Withdraw ${xrpText(position.valueDrops)} XRP`}
      subline={`About ${formatUsd(position.valueUsdMinor)} at today's rate`}
      approveLabel="Withdraw"
      expectedMs={4_000}
      details={
        <div className="flex flex-col gap-1.5 rounded-[16px] border border-line px-4 py-3 text-[14px] text-muted">
          <p>Withdrawals take a few hours. The dollars then come back to your balance.</p>
          {config && <p>{feeLine(config.fees)}</p>}
        </div>
      }
      run={async () => {
        const r = await api.call('earnWithdraw', { body: { amountDrops: position.valueDrops } })
        return {
          title: 'Requested, available in a few hours',
          line: `Available after ${timeText(r.claimableAt)}.`,
          announce: 'Withdrawal requested, available in a few hours',
        }
      }}
      onDone={onRequested}
    />
  )
}
