import type { Metadata } from 'next'
import { MerchantHome } from '@/components/zecca/merchant-home'

export const metadata: Metadata = { title: 'Business' }

export default function MerchantPage() {
  return <MerchantHome />
}
