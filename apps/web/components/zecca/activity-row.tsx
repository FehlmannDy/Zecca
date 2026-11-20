'use client'
// One line of activity: avatar, who or what, note and when, amount (+ in --in when received, plain ink when sent),
// a clock while pending, the word "Failed" when it failed.
import { Clock3, CreditCard, Gem, Plus, TrendingUp, Undo2, type LucideIcon } from 'lucide-react'
import type { Activity } from '@zecca/contracts'
import { activityLine, activityTitle } from '@/lib/activity'
import { cn } from '@/lib/cn'
import { Amount } from './amount'
import { Avatar, Skeleton } from './bits'
import { LogoMark } from './wordmark'

const KIND_ICON: Record<string, LucideIcon> = { topup: Plus, card_load: CreditCard, earn_deposit: TrendingUp, market_buy: Gem, withdraw: Undo2 }

/** People and shops get initials; money from Zecca itself gets the mark; other movements an icon. */
function RowAvatar({ activity, title }: { activity: Activity; title: string }) {
  if (activity.counterparty || activity.receipt) return <Avatar name={title} business={activity.counterparty?.isMerchant || !!activity.receipt} />
  const Icon = KIND_ICON[activity.kind]
  return (
    <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full border border-line bg-surface text-ink">
      {Icon ? <Icon className="size-[18px]" strokeWidth={1.8} /> : <LogoMark className="h-5" title="" />}
    </span>
  )
}

export function ActivityRow({ activity, onOpen, className }: { activity: Activity; onOpen?: (a: Activity) => void; className?: string }) {
  const title = activityTitle(activity)
  const line = activityLine(activity)
  const pending = activity.status === 'pending'
  const failed = activity.status === 'failed'
  const Tag = onOpen ? 'button' : 'div'
  return (
    <Tag
      {...(onOpen ? { type: 'button' as const, onClick: () => onOpen(activity) } : {})}
      className={cn('flex min-h-16 w-full items-center gap-3 rounded-[14px] px-2 py-2.5 text-left', onOpen && 'transition-colors duration-150 hover:bg-ink/[0.04]', className)}
    >
      <RowAvatar activity={activity} title={title} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-[660] text-ink">{title}</span>
        <span className="mt-0.5 block truncate text-[13px] text-muted">{line}</span>
      </span>
      <span className={cn('flex shrink-0 items-center gap-1.5', failed && 'line-through decoration-muted')}>
        {pending && <Clock3 className="size-3.5 text-muted" aria-label="Pending" />}
        <Amount minor={activity.amountMinor} direction={activity.direction} tone={failed ? 'muted' : undefined} />
      </span>
    </Tag>
  )
}

export function ActivityRowSkeleton() {
  return (
    <div className="flex min-h-16 items-center gap-3 px-2 py-2.5" aria-hidden="true">
      <Skeleton className="size-10 rounded-full" />
      <span className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-44" />
      </span>
      <Skeleton className="h-4 w-14" />
    </div>
  )
}
