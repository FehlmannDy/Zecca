// Header and footer for the public pages (/ and /how-it-works).
import Link from 'next/link'
import { Arches } from '@/components/zecca/arches'
import { Logo } from '@/components/zecca/wordmark'
import { FOOTER_LINE, REPO_URL } from './content'
import { LinkButton } from './parts'

/** `sections`: in-page links (the landing's), shown from tablet width. `brand={false}` hides the logo. */
export function SiteHeader({ brand = true, sections = [] }: { brand?: boolean; sections?: readonly { href: string; label: string }[] }) {
  return (
    <header className="sticky top-0 z-20 border-b border-line/70 backdrop-blur-md" style={{ background: 'color-mix(in srgb, var(--paper) 82%, transparent)' }}>
      <div className={`mx-auto flex h-16 w-full max-w-[1120px] items-center gap-3 px-4 sm:px-6 ${brand ? 'justify-between' : 'justify-end'}`}>
        {brand && (
          <Link href="/" aria-label="Zecca, home" className="inline-flex min-h-11 shrink-0 items-center rounded-[10px]">
            <Logo />
          </Link>
        )}
        <nav aria-label="Main" className="flex items-center gap-1 whitespace-nowrap sm:gap-2">
          {sections.map((l) => (
            <a key={l.href} href={l.href} className="hidden min-h-11 items-center rounded-[12px] px-3 text-[14.5px] font-[620] text-muted hover:text-ink md:inline-flex">
              {l.label}
            </a>
          ))}
          {/* Below 380 px with the logo there is no room for both links: the logo leads home, "Open the app" stays. */}
          <Link href="/how-it-works" className={`${brand ? 'hidden min-[380px]:inline-flex' : 'inline-flex'} min-h-11 items-center rounded-[12px] px-2.5 text-[14.5px] font-[620] text-muted hover:text-ink sm:px-3`}>
            How it works
          </Link>
          <LinkButton href="/app" className="min-h-11 px-4 text-[14px]">
            Open the app
          </LinkButton>
        </nav>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="mx-auto w-full max-w-[1120px] px-4 pb-12 pt-4 sm:px-6">
      <Arches variant="divider" />
      <div className="mt-10 flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-col gap-3">
          <Logo />
          <p className="max-w-[46ch] text-[14px] leading-[1.6] text-muted">{FOOTER_LINE}</p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 text-[14px] font-[600]">
          <Link href="/how-it-works" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
            How it works
          </Link>
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-muted hover:text-ink">
            Source code (MIT)
          </a>
        </nav>
      </div>
    </footer>
  )
}
