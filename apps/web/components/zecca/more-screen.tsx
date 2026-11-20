'use client'
// /app/more: everything that is not on the dock, plus sign out. Entries follow the feature flags (more-items.ts).
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'
import { useApp } from '@/lib/app'
import { useSession } from '@/lib/session'
import { moreItems } from './more-items'
import { Skeleton } from './bits'

export function MoreScreen() {
  const { config, signOut } = useApp()
  const session = useSession()
  const router = useRouter()
  const user = session?.user
  return (
    <div className="mx-auto w-full max-w-[560px] px-4 pb-28 pt-3">
      <h1 className="text-[28px] font-[720] tracking-[-0.01em]">More</h1>
      {user && <p className="mt-1 text-[15px] text-muted">@{user.handle}</p>}
      {!config || !user ? (
        <div className="mt-6 space-y-3" aria-label="Loading">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-[20px]" />
          ))}
        </div>
      ) : (
        <ul className="mt-6 overflow-hidden rounded-[20px] border border-line bg-surface">
          {moreItems(config, user).map((item) => (
            <li key={item.href + item.label} className="border-b border-line last:border-b-0">
              <Link href={item.href} className="flex min-h-16 items-center gap-3 px-5 py-3 hover:bg-paper focus-visible:outline-2 focus-visible:outline-brass">
                <span className="flex-1">
                  <span className="block text-[16px] font-[650]">{item.label}</span>
                  {item.hint && <span className="block text-[13.5px] text-muted">{item.hint}</span>}
                </span>
                <ChevronRight className="size-5 text-muted" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={async () => {
          await signOut().catch(() => {})
          router.replace('/app/signup')
        }}
        className="mt-6 min-h-12 w-full rounded-[14px] border border-line bg-surface px-5 text-[15px] font-[650] text-alert hover:border-alert/40"
      >
        Sign out
      </button>
    </div>
  )
}
