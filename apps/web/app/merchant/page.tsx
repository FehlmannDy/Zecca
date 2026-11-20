import type { Metadata } from 'next'
import { MerchantSpace } from '@/components/merchant/merchant-space'

export const metadata: Metadata = { title: 'Business' }

export default function MerchantPage() {
  return <MerchantSpace view="home" />
}
