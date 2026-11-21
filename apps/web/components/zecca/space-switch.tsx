'use client'
// "Personal | Business" next to the logo in both spaces, at every width, so the way back is always in sight.
// An account without a business sees nothing (space-switch-model.ts).
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Store, UserRound } from 'lucide-react'
import type { User } from '@zecca/contracts'
import { cn } from '@/lib/cn'
import { spaceTabs } from './space-switch-model'

const ICONS = { personal: UserRound, business: Store }

export function SpaceSwitch({ user, className }: { user: Pick<User, 'role'> | null | undefined; className?: string }) {
  const tabs = spaceTabs(user, usePathname() ?? '/app')
  if (!tabs) return null
  return (
    <nav aria-label="Switch space" className={cn('flex shrink-0 items-center rounded-full border border-line bg-surface/70', className)}>
      {tabs.map((t) => {
        const Icon = ICONS[t.space]
        return (
          <Link
            key={t.space}
            href={t.href}
            aria-current={t.current ? 'true' : undefined}
            className={cn(
              'inline-flex min-h-11 min-w-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] font-[650] transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brass',
              t.current ? 'bg-ink text-paper' : 'text-muted hover:text-ink',
            )}
          >
            <Icon className="hidden size-4 shrink-0 sm:block" aria-hidden="true" />
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
