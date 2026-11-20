'use client'
// One person or business in the "To" list: avatar, name, @handle. A button that picks them.
import { ChevronRight } from 'lucide-react'
import type { PublicProfile } from '@zecca/contracts'
import { Avatar, Skeleton } from '@/components/zecca/bits'
import { cn } from '@/lib/cn'

export function RecipientRow({ profile, onPick, className }: { profile: PublicProfile; onPick: (p: PublicProfile) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => onPick(profile)}
      className={cn('flex min-h-16 w-full items-center gap-3 rounded-[14px] px-2 py-2.5 text-left transition-colors duration-150 hover:bg-ink/[0.04]', className)}
    >
      <Avatar name={profile.displayName} business={profile.isMerchant} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-[660] text-ink">{profile.displayName}</span>
        <span className="mt-0.5 block truncate text-[13px] text-muted">
          @{profile.handle}
          {profile.isMerchant ? ' · Business' : ''}
        </span>
      </span>
      <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden="true" />
    </button>
  )
}

export function RecipientRowSkeleton() {
  return (
    <div className="flex min-h-16 items-center gap-3 px-2 py-2.5" aria-hidden="true">
      <Skeleton className="size-10 rounded-full" />
      <span className="flex-1 space-y-2">
        <Skeleton className="h-3.5 w-32" />
        <Skeleton className="h-3 w-20" />
      </span>
    </div>
  )
}
