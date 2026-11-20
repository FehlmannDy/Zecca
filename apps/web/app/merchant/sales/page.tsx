import type { Metadata } from 'next'
import { MerchantSpace } from '@/components/merchant/merchant-space'

export const metadata: Metadata = { title: 'Sales' }

export default function SalesPage() {
  return <MerchantSpace view="sales" />
}
