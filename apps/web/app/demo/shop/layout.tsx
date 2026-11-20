import type { Metadata } from 'next'
import { ShopFrame } from '@/components/shop/shop-frame'

export const metadata: Metadata = { title: { default: 'Sette Archi (demo shop)', template: '%s · Sette Archi (demo shop)' } }

export default function ShopLayout({ children }: { children: React.ReactNode }) {
  return <ShopFrame>{children}</ShopFrame>
}
