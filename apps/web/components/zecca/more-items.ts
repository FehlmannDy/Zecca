// The "More" screen's entries. Each phase-2 feature appears only when its flag is on (BUILD §5.3: the UI hides what is off).
import type { PublicConfig, User } from '@zecca/contracts'

export type MoreItem = { href: string; label: string; hint?: string }

export function moreItems(config: PublicConfig, user: User): MoreItem[] {
  const f = config.features
  const items: MoreItem[] = [
    { href: '/app/activity', label: 'Activity', hint: 'Every payment in and out' },
    { href: '/app/request', label: 'Get paid', hint: `Your link and code for @${user.handle}` },
  ]
  if (f.ramp || config.demoMode) items.push({ href: '/app/topup', label: 'Add money', hint: 'Top up with a card' })
  if (f.card) items.push({ href: '/app/card', label: 'Card', hint: 'Pay anywhere cards work' })
  if (f.earn) items.push({ href: '/app/earn', label: 'Earn', hint: 'Put money to work' })
  if (f.market) items.push({ href: '/app/market', label: 'Metals', hint: 'Gold, silver and palladium' })
  if (f.identity) items.push(user.tier === 1 ? { href: '/app/identity', label: 'Identity verified', hint: 'Limits lifted' } : { href: '/app/identity', label: 'Verify your identity', hint: 'Lift the limits' })
  if (f.proofs) items.push({ href: '/app/proofs', label: 'Statements', hint: 'Proof of payments for a tax office or an auditor' })
  if (f.passkey) items.push({ href: '/app/security', label: 'Face ID', hint: 'Approve payments with Face ID' })
  if (user.role.includes('merchant') && user.merchant) items.push({ href: '/merchant', label: user.merchant.businessName, hint: 'Your business space' })
  items.push({ href: '/how-it-works', label: 'How Zecca works', hint: 'What the public ledger sees' })
  return items
}
