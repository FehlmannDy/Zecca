'use client'
// The user space's navigation: Home, Pay, Card, More (Card only when the card feature is on).
// Bottom of the screen on a phone, a vertical glass dock on wide screens.
import { usePathname } from 'next/navigation'
import { CreditCard, Ellipsis, House, ScanLine } from 'lucide-react'
import { Dock, type DockItem } from './glass'

export function appNavItems(pathname: string, cardOn: boolean): DockItem[] {
  const items: DockItem[] = [
    { href: '/app', label: 'Home', icon: House },
    { href: '/app/pay', label: 'Pay', icon: ScanLine },
    ...(cardOn ? [{ href: '/app/card', label: 'Card', icon: CreditCard }] : []),
    { href: '/app/more', label: 'More', icon: Ellipsis },
  ]
  return items.map((i) => ({ ...i, current: i.href === '/app' ? pathname === '/app' : pathname.startsWith(i.href) }))
}

export function BottomDock({ cardOn }: { cardOn: boolean }) {
  const pathname = usePathname() ?? '/app'
  return <Dock items={appNavItems(pathname, cardOn)} label="Main" />
}

export function SideDock({ cardOn }: { cardOn: boolean }) {
  const pathname = usePathname() ?? '/app'
  return <Dock items={appNavItems(pathname, cardOn)} label="Main" side />
}
