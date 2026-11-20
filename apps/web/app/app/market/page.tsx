import type { Metadata } from 'next'
import { MarketScreen } from '@/components/market/market-screen'

export const metadata: Metadata = { title: 'Metals' }

export default function MarketPage() {
  return <MarketScreen />
}
