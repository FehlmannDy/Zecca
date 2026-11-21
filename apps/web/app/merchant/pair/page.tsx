import type { Metadata } from 'next'
import { PairTill } from '@/components/merchant/pair-till'

export const metadata: Metadata = { title: 'Pair a till' }

export default function PairPage() {
  return <PairTill />
}
