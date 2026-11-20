import type { Metadata } from 'next'
import { MerchantSpace } from '@/components/merchant/merchant-space'

export const metadata: Metadata = { title: 'Charge' }

export default function ChargePage() {
  return <MerchantSpace view="charge" />
}
