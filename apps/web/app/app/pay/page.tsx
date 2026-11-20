import type { Metadata } from 'next'
import { PayEntry } from '@/components/merchant/pay-entry'

export const metadata: Metadata = { title: 'Pay' }

export default function PayEntryPage() {
  return <PayEntry />
}
