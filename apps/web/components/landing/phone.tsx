// The hero's product picture: the Zecca home on a phone (balance, the four actions, the card, Earn, activity, the
// dock), drawn with the app's own tokens so it follows light and dark. Decoration: the hero's text says it in words.
import { ArrowDownLeft, ArrowUpRight, CreditCard, Ellipsis, House, Plus, ScanLine, Sprout } from 'lucide-react'
import { Amount } from '@/components/zecca/amount'
import { LogoMark } from '@/components/zecca/wordmark'
import { cn } from '@/lib/cn'
import { CardArt } from './card-art'
import { COFFEE, PHONE } from './content'

const ACTION_ICONS = [ArrowUpRight, ScanLine, Plus, ArrowDownLeft]
const DOCK_ICONS = [House, ScanLine, CreditCard, Ellipsis]

/** The frosted panel of the app's home, small. */
function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn('rounded-[16px] border border-line/80 shadow-[0_6px_18px_-10px_rgb(40_30_10/25%)]', className)}
      style={{ background: 'color-mix(in srgb, var(--surface) 78%, transparent)' }}
    >
      {children}
    </div>
  )
}

function StatusBar() {
  return (
    <div className="flex h-7 items-center justify-between px-5 pt-1 text-[11px] font-[700] text-ink">
      <span className="tabular">9:41</span>
      <span className="flex items-center gap-1" aria-hidden="true">
        <svg viewBox="0 0 17 11" className="h-[9px] w-[15px]" fill="currentColor">
          <rect x="0" y="7" width="3" height="4" rx="1" />
          <rect x="4.5" y="5" width="3" height="6" rx="1" />
          <rect x="9" y="2.5" width="3" height="8.5" rx="1" />
          <rect x="13.5" y="0" width="3" height="11" rx="1" />
        </svg>
        <svg viewBox="0 0 25 12" className="h-[10px] w-[21px]" fill="none" stroke="currentColor">
          <rect x="0.5" y="0.5" width="21" height="11" rx="3.5" opacity="0.4" />
          <rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor" stroke="none" />
          <path d="M23.5 4 V 8" strokeLinecap="round" opacity="0.4" />
        </svg>
      </span>
    </div>
  )
}

/** The arches and dome of the app's backdrop, faint behind the panels. */
function ScreenBackdrop() {
  return (
    <svg viewBox="0 0 280 600" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 h-full w-full" fill="none" stroke="var(--line)" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M110 92 A 30 30 0 0 1 170 92 M 100 92 H 180 M 116 92 V 118 H 164 V 92" />
      <path d="M116 124 L -10 168 M 164 124 L 290 168" />
      {[-34, 46, 126, 206].map((x) => (
        <path key={x} d={`M ${x} 640 V 520 A 36 36 0 0 1 ${x + 72} 520 V 640`} />
      ))}
    </svg>
  )
}

function HomeScreen() {
  return (
    <div className="relative h-full overflow-hidden bg-paper">
      <ScreenBackdrop />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(70% 40% at 60% 28%, color-mix(in srgb, var(--brass) 10%, transparent), transparent 70%)' }} />
      <div className="relative flex h-full flex-col">
        <StatusBar />
        <div className="flex items-center justify-between px-4 pt-2.5">
          <span className="flex items-center gap-1.5 text-ink">
            <LogoMark className="h-[18px]" title="" />
            <span className="font-display text-[10px] font-medium uppercase tracking-[0.22em]">Zecca</span>
          </span>
          <span className="grid size-7 place-items-center rounded-full border border-line bg-surface text-[10px] font-[700] text-ink">{PHONE.initials}</span>
        </div>

        <div className="space-y-2.5 px-3.5 pt-3">
          <Panel className="px-4 pb-3.5 pt-3">
            <span className="font-display text-[8.5px] font-medium uppercase tracking-[0.12em] text-muted">Balance</span>
            <div className="mt-1">
              <Amount minor={PHONE.balanceMinor} size="xl" />
            </div>
            <p className="mt-0.5 text-[10.5px] text-muted">Available</p>
          </Panel>

          <div className="grid grid-cols-4 gap-1 py-0.5">
            {PHONE.actions.map((label, i) => {
              const Icon = ACTION_ICONS[i]
              return (
                <span key={label} className="flex flex-col items-center gap-1 text-[9.5px] font-[650] text-ink">
                  <span className="grid size-9 place-items-center rounded-full bg-ink text-paper">
                    <Icon className="size-[15px]" strokeWidth={2} aria-hidden="true" />
                  </span>
                  {label}
                </span>
              )
            })}
          </div>

          <Panel className="divide-y divide-line/80">
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <CardArt holder={PHONE.holder} last4={PHONE.card.last4} details={false} className="w-[46px] shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-[700] leading-tight text-ink">{PHONE.card.title}</p>
                <p className="tabular text-[10px] text-muted">•••• {PHONE.card.last4}</p>
              </div>
              <span className="rounded-full bg-ink px-2.5 py-1 text-[9.5px] font-[700] text-paper">{PHONE.card.action}</span>
            </div>
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <span className="grid h-[29px] w-[46px] shrink-0 place-items-center rounded-[6px] border border-brass/50 text-brass">
                <Sprout className="size-[15px]" strokeWidth={1.8} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-[700] leading-tight text-ink">{PHONE.earn.title}</p>
                <p className="truncate text-[10px] text-muted">{PHONE.earn.note}</p>
              </div>
              <span className="rounded-full px-2 py-1 text-[9px] font-[700] text-in" style={{ background: 'color-mix(in srgb, var(--in) 12%, transparent)' }}>
                {PHONE.earn.rate}
              </span>
            </div>
          </Panel>

          <Panel className="px-3 pb-1 pt-2.5">
            <p className="text-[12px] font-[720] text-ink">Activity</p>
            <ul>
              {PHONE.activity.map((a) => (
                <li key={a.name} className="flex items-center gap-2.5 py-2">
                  <span className="grid size-[30px] shrink-0 place-items-center rounded-full border border-line bg-surface text-[9.5px] font-[700] text-ink">
                    {a.direction === 'in' ? <LogoMark className="h-[15px]" title="" /> : COFFEE.initials}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px] font-[680] leading-tight text-ink">{a.name}</span>
                    <span className="block truncate text-[9.5px] text-muted">{a.note}</span>
                  </span>
                  <Amount minor={a.amountMinor} direction={a.direction} size="sm" />
                </li>
              ))}
            </ul>
          </Panel>
        </div>

        <div className="mt-auto px-3 pb-3">
          <div className="grid grid-cols-4 rounded-full border border-line/80 p-1 shadow-[0_8px_20px_-12px_rgb(40_30_10/30%)]" style={{ background: 'color-mix(in srgb, var(--surface) 82%, transparent)' }}>
            {PHONE.dock.map((label, i) => {
              const Icon = DOCK_ICONS[i]
              return (
                <span key={label} className={cn('flex flex-col items-center gap-0.5 rounded-full py-1.5 text-[8.5px] font-[650] text-ink', i === 0 && 'bg-surface shadow-[inset_0_-2px_0_var(--brass)]')}>
                  <Icon className="size-[14px]" strokeWidth={1.8} aria-hidden="true" />
                  {label}
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

/** The phone itself: a near-black frame with the island, the screen inside. */
export function Phone({ className }: { className?: string }) {
  return (
    // The frame lifts a little off a dark page (ink is light there), and stays near-black on paper.
    <div style={{ background: 'color-mix(in srgb, var(--ink) 9%, #0c0c0d)' }} className={cn('relative aspect-[300/620] w-full rounded-[46px] p-[9px] shadow-[0_40px_80px_-30px_rgb(40_30_10/45%),0_12px_24px_-12px_rgb(40_30_10/25%)] ring-1 ring-line', className)}>
      <div className="relative h-full overflow-hidden rounded-[38px]">
        <HomeScreen />
        <span className="absolute left-1/2 top-[9px] h-[22px] w-[78px] -translate-x-1/2 rounded-full bg-[#0c0c0d]" aria-hidden="true" />
      </div>
    </div>
  )
}
