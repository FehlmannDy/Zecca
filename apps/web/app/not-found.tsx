// Any unknown URL, and notFound() (an unknown metal symbol): Zecca's own page with a way back (UI.md §6), not the
// framework's bare 404.
import type { Metadata } from 'next'
import Link from 'next/link'
import { Arches } from '@/components/zecca/arches'
import { GlassBackdrop } from '@/components/zecca/glass/backdrop'
import { Logo } from '@/components/zecca/wordmark'

export const metadata: Metadata = { title: 'Page not found' }

const linkCls = 'inline-flex min-h-12 w-full items-center justify-center rounded-[14px] px-5 text-[15px] font-[680] transition-[opacity,border-color] duration-150'

export default function NotFound() {
  return (
    <div className="relative min-h-svh">
      <GlassBackdrop />
      <div className="mx-auto flex min-h-svh max-w-[440px] flex-col px-5 pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))]">
        <Link href="/" aria-label="Zecca home" className="inline-flex min-h-11 items-center self-start rounded-[10px]">
          <Logo />
        </Link>
        <main className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <Arches />
          <h1 className="text-[28px] font-[740] leading-tight tracking-[-0.03em] text-ink">This page doesn’t exist.</h1>
          <p className="max-w-[32ch] text-[15px] text-ink/80">Check the link, or go back to Zecca.</p>
          <div className="mt-4 flex w-full flex-col gap-2">
            <Link href="/app" className={`${linkCls} bg-ink text-paper hover:opacity-90`}>
              Go to the app
            </Link>
            <Link href="/" className={`${linkCls} border border-line bg-surface text-ink hover:border-ink/30`}>
              Go to the home page
            </Link>
          </div>
        </main>
      </div>
    </div>
  )
}
